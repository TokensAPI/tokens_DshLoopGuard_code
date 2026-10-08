// TokensCowork 可调参数唯一入口：loop-guard 的全部默认值集中在这里。
// cordis.patch.yml 的 config 覆盖同名字段；index.js 不另设默认值。

export const REMIND_THRESHOLDS = [3, 5]
// 达到该次数起持续硬阻断(含本次,此后每次重复都阻断)
export const BLOCK_THRESHOLD = 8

// 近似重复（同工具、参数骨架相同但字面量不同）使用独立的链与更宽的阈值，
// 避免误伤「读多个不同文件」式的合法探索。
export const FUZZY_REMIND_THRESHOLDS = [5, 8]
export const FUZZY_BLOCK_THRESHOLD = 12  // 同样为持续阻断起点

// 只对自由文本参数的工具做骨架归一化；read/glob/grep 等以路径为参数的
// 工具保持精确匹配，不同文件不算重复。
export const FUZZY_TOOLS = ['bash', 'pwsh', 'terminal', 'edit', 'write', 'str_replace_editor']

export const INCLUDE = []
export const EXCLUDE = ['todo_write']
export const ARGUMENTS_PREVIEW_CHARS = 500

/* ------------------------- 生成内文本退化护栏 ------------------------- */
// 模型在单次响应内陷入 "Let me X / `--` X" 式碎片循环时,在 llm/stream 层
// 截断该文本块:吞掉后续 delta、替换 block-end 的装配文本为截断版。
// 退化文本因此永远不会进入会话历史,切断"历史喂养新一轮退化"的自增强回路。
export const TEXT_GUARD_ENABLED = true
// 文本块累计字符数达到此值后才开始判定(短文本不检,避免误伤正常旁白)
export const TEXT_GUARD_MIN_CHARS = 1500
// 同一规范化行重复出现该次数即判定退化
export const TEXT_GUARD_MAX_REPEAT_LINES = 10
// 计入重复统计的最小行长度(更短的行不参与计数)
export const TEXT_GUARD_MIN_LINE_LEN = 8
// 硬性上限:无论是否命中重复特征,文本块超过该字符数一律截断(0 = 不启用)
export const TEXT_GUARD_MAX_CHARS = 24000
