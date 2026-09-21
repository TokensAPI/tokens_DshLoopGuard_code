// TokensCowork loop guard.
//
// 取代上游 repeat-tool-reminder（精确匹配、只提醒）:
//   1) 精确重复（同工具 + 参数完全相同）——remindThresholds 提醒,blockThreshold 硬阻断
//   2) 近似重复（自由文本参数的工具,命令骨架相同、字面量不同）——
//      fuzzyRemindThresholds 提醒,fuzzyBlockThreshold 硬阻断
// "硬阻断"是 PostToolDecision 的 block 决定:结果被替换为 isError + 纠正指引,
// 并附带一条插件消息要求模型停下来向用户汇报。
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import {
  ARGUMENTS_PREVIEW_CHARS,
  BLOCK_THRESHOLD,
  EXCLUDE,
  FUZZY_BLOCK_THRESHOLD,
  FUZZY_REMIND_THRESHOLDS,
  FUZZY_TOOLS,
  INCLUDE,
  REMIND_THRESHOLDS,
} from './identity.js'

export const name = 'tokens-loop-guard'

export const Config = z.object({
  remindThresholds: z.array(z.number()).default(REMIND_THRESHOLDS),
  blockThreshold: z.number().default(BLOCK_THRESHOLD),
  fuzzyRemindThresholds: z.array(z.number()).default(FUZZY_REMIND_THRESHOLDS),
  fuzzyBlockThreshold: z.number().default(FUZZY_BLOCK_THRESHOLD),
  fuzzyTools: z.array(z.string()).default(FUZZY_TOOLS),
  include: z.array(z.string()).default(INCLUDE),
  exclude: z.array(z.string()).default(EXCLUDE),
  argumentsPreviewChars: z.number().default(ARGUMENTS_PREVIEW_CHARS),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'tokens-loop-guard' }

/* ------------------------------ 参数指纹 ------------------------------ */

/** 深 key 排序,得到与属性顺序无关的确定性结构(同上游语义)。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function parseArguments(args) {
  if (typeof args !== 'string') return args
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * 命令骨架归一化:保留命令结构(动词、管道、重定向、选项),抹掉字面量。
 * `grep -n "a" /x/f1.js` 与 `grep -n "b" /x/f2.js` 得到同一骨架;
 * `cat f1` 与 `rm -rf f1` 骨架不同。
 */
function normalizeCommandString(text) {
  return text
    .replace(/'[^']*'/g, '«sq»')
    .replace(/"[^"]*"/g, '«dq»')
    .replace(/`[^`]*`/g, '«bq»')
    .replace(/\/[\w.@%+\-/]+/g, '«path»')
    .replace(/\b\d+(?:\.\d+)?\b/g, '«n»')
    .replace(/\s+/g, ' ')
    .trim()
}

function skeletonize(value) {
  if (typeof value === 'string') return normalizeCommandString(value)
  if (typeof value === 'number') return '«num»'
  if (Array.isArray(value)) return value.map(skeletonize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, skeletonize(value[key])]),
    )
  }
  return value
}

/* ------------------------------ 文本构造 ------------------------------ */

function previewArguments(canonical, cap) {
  const text = JSON.stringify(canonical)
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}… (+${text.length - cap} more chars)`
}

function exactReminder(toolName, count, canonical, cap) {
  return `Repeated tool call detected:
- tool: ${toolName}
- consecutive_calls: ${count}
- arguments: ${previewArguments(canonical, cap)}
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.`
}

function fuzzyReminder(toolName, count, skeleton, cap) {
  return `You have called "${toolName}" ${count} times in a row with the same command shape and only literal changes (paths, quotes, numbers):
- shape: ${previewArguments(skeleton, cap)}
This trial-and-error pattern is not making progress. Stop guessing: step back, state what you actually need, read documentation or ask the user instead of issuing another variant of the same command.`
}

function blockFeedback(toolName, count, fuzzy) {
  const kind = fuzzy ? 'the same command shape with only literal changes' : 'identical arguments'
  return [
    `LOOP GUARD: blocked a repeated ${toolName} call (${count} consecutive calls with ${kind}).`,
    'The loop guard has stopped this call because repeating it is not producing new information.',
    'Do NOT retry this call or minor variants of it.',
    'Instead, do one of the following now:',
    '1. Summarize to the user what you have found so far and what is blocking progress;',
    '2. Ask the user for the missing information or for a decision;',
    '3. If the task is effectively complete, finish with a final answer.',
  ].join('\n')
}

function blockNotice(toolName, count) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `The loop guard blocked your last "${toolName}" call after ${count} consecutive repeats. Stop this line of trial-and-error and report to the user: what you tried, what you learned, and what you need next.`,
    }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${toolName} × ${count} blocked` },
  }
}

/* ------------------------------ 校验 ------------------------------ */

function validateThresholds(list, label) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`tokens-loop-guard: ${label} must not be empty`)
  const seen = new Set()
  for (const value of list) {
    if (!Number.isInteger(value) || value < 2) throw new Error(`tokens-loop-guard: ${label} entry ${value} must be an integer >= 2`)
    if (seen.has(value)) throw new Error(`tokens-loop-guard: ${label} entry ${value} is duplicated`)
    seen.add(value)
  }
  return list
}

function validateBlockThreshold(value, reminds, label) {
  if (!Number.isInteger(value) || value < 2) throw new Error(`tokens-loop-guard: ${label} must be an integer >= 2`)
  if (value <= Math.max(...reminds)) {
    throw new Error(`tokens-loop-guard: ${label} (${value}) must be greater than every reminder threshold (${reminds.join(', ')})`)
  }
  return value
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')
  return new RegExp(`^${escaped}$`)
}

/* ------------------------------ 插件主体 ------------------------------ */

export function apply(ctx, config) {
  const remindThresholds = validateThresholds(config.remindThresholds, 'remindThresholds')
  const blockThreshold = validateBlockThreshold(config.blockThreshold, remindThresholds, 'blockThreshold')
  const fuzzyRemindThresholds = validateThresholds(config.fuzzyRemindThresholds, 'fuzzyRemindThresholds')
  const fuzzyBlockThreshold = validateBlockThreshold(config.fuzzyBlockThreshold, fuzzyRemindThresholds, 'fuzzyBlockThreshold')
  if (!Number.isInteger(config.argumentsPreviewChars) || config.argumentsPreviewChars < 1) {
    throw new Error(`tokens-loop-guard: invalid argumentsPreviewChars ${config.argumentsPreviewChars} — must be an integer >= 1`)
  }
  const remindSet = new Set(remindThresholds)
  const fuzzyRemindSet = new Set(fuzzyRemindThresholds)
  const includePatterns = config.include.map(wildcardToRegExp)
  const excludePatterns = config.exclude.map(wildcardToRegExp)
  const fuzzyToolSet = new Set(config.fuzzyTools)
  const cap = config.argumentsPreviewChars

  const chains = new WeakMap()

  function tracked(toolName) {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * 推进链并返回处置:{ reminder } 注入提醒,或 { block: true } 硬阻断。
   * 精确链与骨架链各自独立计数;精确重复同时推进两条链。
   */
  function observe(exec) {
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    const parsed = parseArguments(exec.arguments)
    const canonical = canonicalize(parsed)
    const exactKey = JSON.stringify([exec.name, canonical])
    const fuzzyKey = fuzzyToolSet.has(exec.name)
      ? JSON.stringify([exec.name, skeletonize(parsed)])
      : exactKey

    const chain = chains.get(exec.agent) ?? { exactKey: '', fuzzyKey: '', exactCount: 0, fuzzyCount: 0 }
    chain.exactCount = chain.exactKey === exactKey ? chain.exactCount + 1 : 1
    chain.fuzzyCount = chain.fuzzyKey === fuzzyKey ? chain.fuzzyCount + 1 : 1
    chain.exactKey = exactKey
    chain.fuzzyKey = fuzzyKey
    chains.set(exec.agent, chain)

    // 纯精确链由精确路径处置;骨架路径只在链发生漂移(字面量变化)时介入。
    const drifted = chain.fuzzyCount > chain.exactCount
    // 阻断必须"守住":达到阈值后的每一次调用都阻断,只在跨阈值那一次附通知,
    // 避免模型在被明确指示继续时越过单次阻断继续循环。
    if (chain.exactCount >= blockThreshold) {
      return { block: true, fuzzy: false, count: chain.exactCount, first: chain.exactCount === blockThreshold }
    }
    if (drifted && chain.fuzzyCount >= fuzzyBlockThreshold) {
      return { block: true, fuzzy: true, count: chain.fuzzyCount, first: chain.fuzzyCount === fuzzyBlockThreshold }
    }
    if (remindSet.has(chain.exactCount)) {
      return {
        reminder: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: exactReminder(exec.name, chain.exactCount, canonical, cap) }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${chain.exactCount}` },
        },
      }
    }
    if (drifted && fuzzyRemindSet.has(chain.fuzzyCount)) {
      return {
        reminder: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: fuzzyReminder(exec.name, chain.fuzzyCount, skeletonize(parsed), cap) }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} ≈ ${chain.fuzzyCount}` },
        },
      }
    }
    return undefined
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const action = observe(exec)
    const downstream = await next()
    if (action?.block === true) {
      const feedback = [{
        type: 'text',
        text: blockFeedback(exec.name, action.count, action.fuzzy),
      }]
      // 每次被阻断的调用都以 isError 纠错反馈呈现;插件通知只在跨阈值那一次注入,
      // 后续阻断靠反馈本身约束,不再追加消息。
      const contexts = action.first === true
        ? [blockNotice(exec.name, action.count), ...downstream.additionalContexts ?? []]
        : downstream.additionalContexts ?? []
      return {
        kind: 'block',
        feedback,
        ...contexts.length > 0 ? { additionalContexts: contexts } : {},
      }
    }
    if (!action?.reminder) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [action.reminder, ...downstream.additionalContexts ?? []],
      }
    }
    return {
      ...downstream,
      additionalContexts: [action.reminder, ...downstream.additionalContexts ?? []],
    }
  })

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
