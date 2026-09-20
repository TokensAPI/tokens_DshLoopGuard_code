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
