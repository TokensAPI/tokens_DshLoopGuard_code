#!/usr/bin/env node
/* ====================================================================
 * e2e: 生成内文本退化护栏(guardStream)× 真实模型,流式对照
 *
 * 用触发退化的真实会话上下文(fixtures/degenerate-context.json),
 * 对比无护栏/有护栏的流式输出:有护栏时重复碎片应在阈值处被截断,
 * 且同响应的工具调用照常透传。
 *
 * 运行:
 *   LOOP_GUARD_E2E_URL=http://127.0.0.1:8083 node test/e2e/live-text-guard.mjs
 *   LOOP_GUARD_E2E_URL=... node test/e2e/live-text-guard.mjs --guard off
 *
 * 预期:
 *   guard off:大段 "Let me X" 碎片(可超过 10K 字符,甚至 0 调用耗尽)
 *   guard on :文本在重复阈值处截断(含 "[loop-guard]" 标记),工具调用保留
 * ==================================================================== */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { guardStream } from '../../index.js'

const CFG = { minChars: 1500, maxRepeatLines: 10, minLineLen: 8, maxChars: 24000 }
const GUARD = process.argv.includes('--guard')
const BASE_URL = (process.env.LOOP_GUARD_E2E_URL ?? 'http://127.0.0.1:8083').replace(/\/$/, '')
const MODEL = process.env.LOOP_GUARD_E2E_MODEL ?? 'deepseek-v4-flash-vision-exp'
const CONTEXT_PATH = process.env.LOOP_GUARD_E2E_CONTEXT
  ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'degenerate-context.json')

/* ---- 端点探测,不通则跳过 ---- */
try {
  const probe = await fetch(`${BASE_URL}/v1/models`, { signal: AbortSignal.timeout(5000) })
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
} catch {
  console.log(`SKIP: 模型 endpoint 不可达 (${BASE_URL}),设置 LOOP_GUARD_E2E_URL 后重试`)
  process.exit(0)
}

const req = JSON.parse(readFileSync(CONTEXT_PATH, 'utf8'))
const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 8192,
    messages: req.messages,
    tools: req.tools,
    stream: true,
  }),
  signal: AbortSignal.timeout(600_000),
})
if (!response.ok) {
  console.log('HTTP', response.status, (await response.text()).slice(0, 200))
  process.exit(1)
}

/* SSE → StreamChunk 序列(OpenAI chat/completions 流式格式) */
async function* sseChunks(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let blockIndex = -1
  let inToolCall = false
  const toolAcc = { id: '', name: '', args: '' }
  for await (const wire of body) {
    buffer += decoder.decode(wire, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
      if (!dataLine) continue
      const data = dataLine.slice(5).trim()
      if (data === '[DONE]') return
      let payload
      try { payload = JSON.parse(data) } catch { continue }
      const choice = payload.choices?.[0]
      const delta = choice?.delta ?? {}
      if (delta.content !== undefined && !inToolCall) {
        if (blockIndex < 0) {
          blockIndex = 0
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        if (delta.content) yield { type: 'text-delta', index: 0, text: delta.content }
      }
      for (const tc of delta.tool_calls ?? []) {
        inToolCall = true
        if (tc.id) { toolAcc.id = tc.id; toolAcc.name = tc.function?.name ?? '' }
        if (tc.function?.arguments) toolAcc.args += tc.function.arguments
      }
      if (choice?.finish_reason) {
        if (blockIndex >= 0 && !inToolCall) {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
        }
        if (inToolCall && toolAcc.id) {
          yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: toolAcc.id, name: toolAcc.name, arguments: toolAcc.args } }
        }
        yield { type: 'finish', reason: choice.finish_reason }
      }
    }
  }
}

const source = sseChunks(response.body)
const stream = GUARD ? guardStream(source, CFG) : source

let text = ''
let calls = 0
let finish = ''
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls += 1
  if (chunk.type === 'finish') finish = chunk.reason
}
console.log(`guard=${GUARD ? 'on' : 'off'} | text=${text.length}c | LetMe=${(text.match(/Let me/g) ?? []).length} | calls=${calls} | finish=${finish}`)
if (text.includes('loop-guard')) console.log('  → 含截断标记 ✓')
console.log('  结尾:', text.slice(-160).replaceAll('\n', ' '))
