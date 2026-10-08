#!/usr/bin/env node
/* ====================================================================
 * e2e: loop-guard 工具调用链护栏 × 真实模型
 *
 * 最小 agent 循环驱动器替代完整 harness:
 *   模型(completions 协议)→ tool_call → 罐头执行结果
 *   → 真实插件的 tools/post-execute 监听器 → accept(附提醒)/block → 回灌
 *
 * 运行:
 *   LOOP_GUARD_E2E_URL=http://127.0.0.1:8083 node test/e2e/live-loop.mjs
 *   LOOP_GUARD_E2E_URL=... node test/e2e/live-loop.mjs --guard off   # 对照
 *
 * 环境变量:
 *   LOOP_GUARD_E2E_URL    模型 endpoint(默认 http://127.0.0.1:8083)
 *   LOOP_GUARD_E2E_MODEL  模型名(默认 deepseek-v4-flash-vision-exp)
 *
 * 预期:
 *   guard on :第 3 次重复触发提醒(×3),第 8 次起持续 BLOCKED
 *   guard off:同一调用无限重复
 * ==================================================================== */
import { apply } from '../../index.js'
import {
  ARGUMENTS_PREVIEW_CHARS, BLOCK_THRESHOLD, EXCLUDE, FUZZY_BLOCK_THRESHOLD,
  FUZZY_REMIND_THRESHOLDS, FUZZY_TOOLS, INCLUDE, REMIND_THRESHOLDS,
} from '../../identity.js'

const BASE_URL = (process.env.LOOP_GUARD_E2E_URL ?? 'http://127.0.0.1:8083').replace(/\/$/, '')
const MODEL = process.env.LOOP_GUARD_E2E_MODEL ?? 'deepseek-v4-flash-vision-exp'
const GUARD_ON = !process.argv.includes('--guard') || process.argv[process.argv.indexOf('--guard') + 1] !== 'off'
const MAX_STEPS = 12
const PRIME = Number(process.env.LOOP_GUARD_E2E_PRIME ?? 8)

/* ---- 端点探测,不通则跳过 ---- */
try {
  const probe = await fetch(`${BASE_URL}/v1/models`, { signal: AbortSignal.timeout(5000) })
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
} catch {
  console.log(`SKIP: 模型 endpoint 不可达 (${BASE_URL}),设置 LOOP_GUARD_E2E_URL 后重试`)
  process.exit(0)
}

/* ---- 挂载真实插件 ---- */
const listeners = []
apply({ on: (event, fn) => listeners.push({ event, fn }) }, {
  remindThresholds: REMIND_THRESHOLDS, blockThreshold: BLOCK_THRESHOLD,
  fuzzyRemindThresholds: FUZZY_REMIND_THRESHOLDS, fuzzyBlockThreshold: FUZZY_BLOCK_THRESHOLD,
  fuzzyTools: FUZZY_TOOLS, include: INCLUDE, exclude: EXCLUDE,
  argumentsPreviewChars: ARGUMENTS_PREVIEW_CHARS,
})
const postExecute = listeners.find(l => l.event === 'tools/post-execute').fn
const agent = {}

const CANNED_OUTPUT = `1:import { assertDesktopProfileName } from "./profile-manager.js";
2:import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
33:var DesktopPluginsError = class extends Error {
44:		profiles: []`
const TOOLS = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
}]
const LOOP_CALL_ARGS = JSON.stringify({ command: 'grep -n "plugin" /Applications/app/lib/plugins.js 2>/dev/null | head -40', description: 'Inspect plugin loading logic' })

const messages = [{ role: 'user', content: '帮我链接一下notion' }]
for (let index = 0; index < PRIME; index += 1) {
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_p${index}`, type: 'function', function: { name: 'bash', arguments: LOOP_CALL_ARGS } }] })
  messages.push({ role: 'tool', tool_call_id: `call_p${index}`, content: CANNED_OUTPUT })
}

let blocked = 0
let reminded = 0
for (let step = 1; step <= MAX_STEPS; step += 1) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages, tools: TOOLS }),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json()
  if (!response.ok) { console.log(`step ${step}: HTTP ${response.status}`); break }
  const msg = payload.choices?.[0]?.message ?? {}
  const calls = msg.tool_calls ?? []

  if (calls.length === 0) {
    console.log(`step ${step}: 模型停止调用工具,输出文本:`)
    console.log(String(msg.content ?? '').slice(0, 300))
    break
  }

  for (const call of calls) {
    messages.push({ role: 'assistant', content: null, tool_calls: [call] })
    const argsText = call.function.arguments
    let verdict = 'exec'
    if (GUARD_ON) {
      const decision = await postExecute(
        { agent, name: call.function.name, arguments: argsText }, {},
        async () => ({ kind: 'accept' }),
      )
      if (decision.kind === 'block') {
        verdict = 'BLOCKED'
        blocked += 1
        messages.push({ role: 'tool', tool_call_id: call.id, content: decision.feedback.map(b => b.text).join('\n') })
        for (const ctxMsg of decision.additionalContexts ?? []) {
          messages.push({ role: 'user', content: ctxMsg.content.map(c => c.text ?? '').join('\n') })
        }
        console.log(`step ${step}: ${verdict} ${argsText.slice(0, 70)}`)
        continue
      }
      if ((decision.additionalContexts ?? []).length > 0) {
        verdict = 'reminded'
        reminded += 1
        for (const ctxMsg of decision.additionalContexts) {
          messages.push({ role: 'user', content: ctxMsg.content.map(c => c.text ?? '').join('\n') })
        }
      }
    }
    messages.push({ role: 'tool', tool_call_id: call.id, content: CANNED_OUTPUT })
    console.log(`step ${step}: ${verdict} ${argsText.slice(0, 70)}`)
  }
}
console.log(`summary: guard=${GUARD_ON ? 'on' : 'off'}, reminded=${reminded}, blocked=${blocked}`)
