# tokens_DshLoopGuard_code

TokensCowork 的循环护栏插件，npm 包名为 `@tokens/dsh-loop-guard`。检测 agent 的工具调用循环，先提醒、后硬阻断，替代上游 `@deepseek-ai/dsh-repeat-tool-reminder`。

## 背景

上游 repeat-tool-reminder 有两个已知盲区（其 README 自述为刻意取舍）:

1. **只认精确重复**——参数有任何变化就重置计数。"每次微调参数的试错式循环"(同一命令骨架、只换路径/字符串)完全逃逸。
2. **只提醒不阻断**——提醒可被模型无视;超过最高阈值(8 次)后彻底静默,循环无人接管。

两个真实会话分别踩中这两类:

- 试错式循环:同一 asar 逆向命令连续 16 个变体,护栏零触发。
- 精确重复死循环:同一命令连续 58 次,×3/×5/×8 提醒全被无视,直到用户手动中止。

## 功能

挂载在 `tools/post-execute` 瀑布上,为每个 agent 维护两条链:

| 链 | 检测方式 | 提醒(默认) | 硬阻断(默认) |
|---|---|---|---|
| 精确重复 | 同工具 + 参数完全相同(深度 key 排序后比对,与上游同语义) | 第 3、5 次 | **第 8 次** |
| 近似重复 | 自由文本工具(bash/pwsh/terminal/edit/write/str_replace_editor)按命令骨架归一化:剥离引号/路径/数字字面量,保留命令结构 | 第 5、8 次 | **第 12 次** |

- **硬阻断**:返回 `PostToolDecision { kind: 'block' }`——该次工具结果替换为 isError 纠错指引,并附插件消息要求模型停止试错、向用户汇报进展。被阻断的调用已经执行(与上游设计空间一致),但模型看到的是失败与纠正指引。
- **不误伤**:`read`/`glob`/`grep` 等以路径为参数的工具只做精确匹配,读不同文件不算重复;骨架链只在"链发生漂移"(字面量变化)时介入,纯精确重复由精确链处置。
- 每 agent 独立计数(`WeakMap`),新用户消息重置;`include`/`exclude` 之外的调用不进链也不重置链;配置非法时加载即报错(fail-loud)。

## 配置

`cordis.patch.yml` 的 `config:` 可覆盖以下字段(默认值集中在 `identity.js`):

| 字段 | 默认 | 含义 |
|---|---|---|
| `remindThresholds` | `[3, 5]` | 精确重复提醒的连续次数 |
| `blockThreshold` | `8` | 精确重复硬阻断次数(须大于所有提醒阈值) |
| `fuzzyRemindThresholds` | `[5, 8]` | 近似重复提醒的连续次数 |
| `fuzzyBlockThreshold` | `12` | 近似重复硬阻断次数(须大于所有近似提醒阈值) |
| `fuzzyTools` | `[bash, pwsh, terminal, edit, write, str_replace_editor]` | 启用骨架归一化的工具 |
| `include` | `[]` | 只跟踪这些工具(支持 `*` 通配);空 = 全部 |
| `exclude` | `[todo_write]` | 不跟踪这些工具(不计数也不重置) |
| `argumentsPreviewChars` | `500` | 提醒消息中参数预览的字符上限 |

## 与上游护栏的关系

TokensCowork 产品内置本插件时,装配层(`build/modules/guard/loop-guard-overlay.mjs`)会在 Desktop 补丁层停用上游 `repeat-tool-reminder`,避免同一次重复注入两条提醒;本插件未启用时上游护栏保持兜底。

## 开发

```bash
npm install
npm test          # node --test,12 项:双链计数、阈值提醒、硬阻断、排除与重置、配置校验
```

核心文件:

- `index.js`:插件主体(链计数、骨架归一化、提醒与阻断决策)。
- `identity.js`:全部可调默认值唯一入口(本产品约定)。
- `cordis.patch.yml`:bundle 挂载声明。

## 许可

MIT License,见 `LICENSE`。
