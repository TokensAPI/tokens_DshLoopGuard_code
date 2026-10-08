import assert from 'node:assert/strict'
import { test } from 'node:test'

import { guardStream } from '../index.js'

const CFG = {
  minChars: 200,
  maxRepeatLines: 5,
  minLineLen: 8,
  maxChars: 0,
}

async function* chunks(list) {
  for (const chunk of list) yield chunk
}

async function collect(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function textStream(text, { index = 0, deltaSize = 40, withToolCall = false } = {}) {
  const list = [{ type: 'block-start', index, blockType: 'text' }]
  for (let i = 0; i < text.length; i += deltaSize) {
    list.push({ type: 'text-delta', index, text: text.slice(i, i + deltaSize) })
  }
  list.push({ type: 'block-end', index, block: { type: 'text', text } })
  if (withToolCall) {
    list.push({ type: 'block-start', index: index + 1, blockType: 'tool-call' })
    list.push({ type: 'tool-call-delta', index: index + 1, id: 'call_1', name: 'bash', argumentsDelta: '{"command":"ls"}' })
    list.push({ type: 'block-end', index: index + 1, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } })
  }
  list.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
  list.push({ type: 'finish', reason: 'stop' })
  return list
}

test('degenerate text is truncated and the block-end carries the kept prefix', async () => {
  const junk = 'Let me read the results section.\n'
  const text = `Now I will check the file.\n${junk.repeat(12)}`
  const out = await collect(guardStream(chunks(textStream(text)), CFG))

  const blockEnd = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.ok(blockEnd, 'block-end 应存在')
  assert.ok(blockEnd.block.text.length < text.length, '装配文本应被截断')
  assert.match(blockEnd.block.text, /Repetitive output detected/)
  assert.match(blockEnd.block.text, /Now I will check the file/)
  // 触发后不再有大段垃圾
  assert.ok((blockEnd.block.text.match(/Let me read the results section/g) ?? []).length < 12)
  // finish/usage 透传
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-2).type, 'usage')
})

test('normal varied text passes through unchanged', async () => {
  const text = 'Here is a real answer.\nIt has several different lines.\nEach one says something new.\nAnd nothing repeats at all.'
  const out = await collect(guardStream(chunks(textStream(text)), CFG))
  const blockEnd = out.find(chunk => chunk.type === 'block-end')
  assert.equal(blockEnd.block.text, text)
})

test('repetition below the threshold is not truncated', async () => {
  const line = 'This line appears a few times.\n'
  const text = `Intro sentence here.\n${line.repeat(4)}Different ending line.`
  const out = await collect(guardStream(chunks(textStream(text)), CFG))
  const blockEnd = out.find(chunk => chunk.type === 'block-end')
  assert.equal(blockEnd.block.text, text)
})

test('tool-call blocks flow through even after a text truncation', async () => {
  const junk = 'Let me click the button now.\n'
  const text = `Checking first.\n${junk.repeat(12)}`
  const out = await collect(guardStream(chunks(textStream(text, { withToolCall: true })), CFG))
  const toolEnd = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.ok(toolEnd, '工具调用块应透传')
  assert.equal(toolEnd.block.name, 'bash')
})

test('hard cap truncates even without repeat evidence', async () => {
  const cfg = { ...CFG, maxChars: 500 }
  const text = 'word '.repeat(300)
  const out = await collect(guardStream(chunks(textStream(text)), cfg))
  const blockEnd = out.find(chunk => chunk.type === 'block-end')
  assert.match(blockEnd.block.text, /maximum length/)
  assert.ok(blockEnd.block.text.length < text.length)
})

test('reasoning degeneration is truncated too', async () => {
  const junk = 'I keep repeating the same grep.\n'
  const reasoning = `Let me think.\n${junk.repeat(30)}`
  const list = [{ type: 'block-start', index: 0, blockType: 'reasoning' }]
  for (let i = 0; i < reasoning.length; i += 40) {
    list.push({ type: 'reasoning-delta', index: 0, text: reasoning.slice(i, i + 40) })
  }
  list.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
  list.push({ type: 'finish', reason: 'stop' })
  const out = await collect(guardStream(chunks(list), CFG))
  const blockEnd = out.find(chunk => chunk.type === 'block-end')
  assert.match(blockEnd.block.text, /Repetitive output detected/)
  assert.ok(blockEnd.block.text.length < reasoning.length)
})

test('short texts below minChars are never truncated', async () => {
  const line = 'repeat me please.\n'
  const text = line.repeat(8) // 远小于 minChars=200
  const out = await collect(guardStream(chunks(textStream(text)), CFG))
  const blockEnd = out.find(chunk => chunk.type === 'block-end')
  assert.equal(blockEnd.block.text, text)
})
