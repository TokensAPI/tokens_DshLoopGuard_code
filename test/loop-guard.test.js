import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, name } from '../index.js'

const DEFAULT_CONFIG = {
  remindThresholds: [3, 5],
  blockThreshold: 8,
  fuzzyRemindThresholds: [5, 8],
  fuzzyBlockThreshold: 12,
  fuzzyTools: ['bash'],
  include: [],
  exclude: ['todo_write'],
  argumentsPreviewChars: 500,
}

/** 最小 cordis 替身:捕获 listener,按注册序驱动 post-execute 瀑布。 */
function createHarness(config = DEFAULT_CONFIG) {
  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
    },
  }
  apply(ctx, config)

  const agent = {}
  async function call(toolName, args) {
    const exec = { agent, name: toolName, arguments: JSON.stringify(args) }
    let decision = { kind: 'accept' }
    for (const listener of listeners.get('tools/post-execute') ?? []) {
      decision = await listener(exec, {}, async () => decision)
    }
    return decision
  }
  async function userMessage() {
    for (const listener of listeners.get('agent/pre-step') ?? []) {
      await listener({ agent, messages: [{ source: { kind: 'user' } }] }, async () => undefined)
    }
  }
  const reminders = decision => (decision.additionalContexts ?? []).map(entry => entry.content?.[0]?.text ?? '')
  return { call, userMessage, reminders }
}

test('exact repeats remind at configured thresholds', async () => {
  const h = createHarness()
  assert.deepEqual(await h.call('bash', { command: 'ls /a' }), { kind: 'accept' })
  assert.deepEqual(await h.call('bash', { command: 'ls /a' }), { kind: 'accept' })
  const third = await h.call('bash', { command: 'ls /a' })
  assert.equal(third.kind, 'accept')
  assert.equal(h.reminders(third).length, 1)
  assert.match(h.reminders(third)[0], /consecutive_calls: 3/)
  const fourth = await h.call('bash', { command: 'ls /a' })
  assert.equal(h.reminders(fourth).length, 0)
  const fifth = await h.call('bash', { command: 'ls /a' })
  assert.match(h.reminders(fifth)[0], /consecutive_calls: 5/)
})

test('exact repeats hard-block at blockThreshold', async () => {
  const h = createHarness()
  for (let index = 0; index < 7; index += 1) await h.call('bash', { command: 'grep x /f' })
  const eighth = await h.call('bash', { command: 'grep x /f' })
  assert.equal(eighth.kind, 'block')
  assert.match(eighth.feedback[0].text, /LOOP GUARD/)
  assert.match(eighth.feedback[0].text, /8 consecutive calls/)
  assert.match(h.reminders(eighth)[0], /blocked your last "bash" call/)
})

test('argument property order does not evade exact matching', async () => {
  const h = createHarness()
  await h.call('bash', { command: 'ls /a', description: 'x' })
  await h.call('bash', { description: 'x', command: 'ls /a' })
  const third = await h.call('bash', { command: 'ls /a', description: 'x' })
  assert.match(h.reminders(third)[0], /consecutive_calls: 3/)
})

test('near-identical command variants advance only the fuzzy chain', async () => {
  const h = createHarness()
  const variants = [
    'grep -n "plugin" /app/a.js',
    'grep -n "plugin" /app/b.js',
    'grep -n "plugin" /app/c.js',
    'grep -n "plugin" /app/d.js',
  ]
  for (const command of variants) {
    const decision = await h.call('bash', { command })
    // 精确链每步都重置,精确提醒不触发
    assert.equal(h.reminders(decision).length, 0)
  }
  const fifth = await h.call('bash', { command: 'grep -n "plugin" /app/e.js' })
  assert.match(h.reminders(fifth)[0], /same command shape/)
  assert.match(h.reminders(fifth)[0], /5 times in a row/)
})

test('fuzzy chain hard-blocks at fuzzyBlockThreshold', async () => {
  const h = createHarness()
  for (let index = 0; index < 11; index += 1) await h.call('bash', { command: `cat /data/f${index}.log` })
  const twelfth = await h.call('bash', { command: 'cat /data/f11.log' })
  assert.equal(twelfth.kind, 'block')
  assert.match(twelfth.feedback[0].text, /same command shape with only literal changes/)
})

test('different command shapes reset the fuzzy chain', async () => {
  const h = createHarness()
  for (let index = 0; index < 11; index += 1) await h.call('bash', { command: `cat /data/f${index}.log` })
  await h.call('bash', { command: 'ls /data' })
  const decision = await h.call('bash', { command: 'cat /data/again.log' })
  assert.equal(decision.kind, 'accept')
})

test('tools outside fuzzyTools only count exact repeats', async () => {
  const h = createHarness()
  // read 不在 fuzzyTools:读不同文件不算重复
  for (let index = 0; index < 6; index += 1) {
    const decision = await h.call('read', { file_path: `/src/file${index}.js` })
    assert.equal(decision.kind, 'accept')
    assert.equal(h.reminders(decision).length, 0)
  }
  // 但 read 同一文件精确重复仍计数
  await h.call('read', { file_path: '/src/same.js' })
  await h.call('read', { file_path: '/src/same.js' })
  const third = await h.call('read', { file_path: '/src/same.js' })
  assert.match(h.reminders(third)[0], /consecutive_calls: 3/)
})

test('excluded tools neither count nor reset', async () => {
  const h = createHarness()
  await h.call('bash', { command: 'ls /a' })
  await h.call('todo_write', { items: [] })
  await h.call('bash', { command: 'ls /a' })
  const third = await h.call('bash', { command: 'ls /a' })
  assert.match(h.reminders(third)[0], /consecutive_calls: 3/)
})

test('a new user message clears the chains', async () => {
  const h = createHarness()
  await h.call('bash', { command: 'ls /a' })
  await h.call('bash', { command: 'ls /a' })
  await h.userMessage()
  const decision = await h.call('bash', { command: 'ls /a' })
  assert.equal(h.reminders(decision).length, 0)
})

test('untracked include list restricts tracking', async () => {
  const h = createHarness({ ...DEFAULT_CONFIG, include: ['bash'] })
  await h.call('read', { file_path: '/a' })
  await h.call('read', { file_path: '/a' })
  const third = await h.call('read', { file_path: '/a' })
  assert.equal(h.reminders(third).length, 0)
})

test('invalid thresholds fail loudly', () => {
  assert.throws(
    () => apply({ on() {} }, { ...DEFAULT_CONFIG, remindThresholds: [] }),
    /must not be empty/,
  )
  assert.throws(
    () => apply({ on() {} }, { ...DEFAULT_CONFIG, blockThreshold: 5 }),
    /must be greater than every reminder threshold/,
  )
  assert.throws(
    () => apply({ on() {} }, { ...DEFAULT_CONFIG, remindThresholds: [3, 3] }),
    /duplicated/,
  )
})

test('plugin identity', () => {
  assert.equal(name, 'tokens-loop-guard')
})
