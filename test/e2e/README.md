# e2e 测试(需要真实模型 endpoint)

本目录的测试依赖一个可访问的 OpenAI 兼容模型 endpoint,**不参与 `npm test`**
的默认运行,需手动执行。endpoint 不可达时脚本打印 `SKIP` 并以 0 退出。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `LOOP_GUARD_E2E_URL` | `http://127.0.0.1:8083` | 模型 endpoint(completions 协议) |
| `LOOP_GUARD_E2E_MODEL` | `deepseek-v4-flash-vision-exp` | 模型名 |
| `LOOP_GUARD_E2E_CONTEXT` | `fixtures/degenerate-context.json` | live-text-guard 的退化上下文 |
| `LOOP_GUARD_E2E_PRIME` | `8` | live-loop 预置的重复历史轮数 |

官方 DeepSeek API 等需要鉴权的 endpoint 暂不在脚本内支持,请用本地/内网
vLLM;鉴权 key 一律走环境变量,不要写进任何文件。

## live-loop.mjs —— 工具调用链护栏

最小 agent 循环替代完整 harness:预置 N 轮完全相同的历史调用后让真实模型继续,
每个 tool_call 经过真实插件的 `tools/post-execute` 监听器,执行结果用罐头输出。

```bash
LOOP_GUARD_E2E_URL=http://127.0.0.1:8083 node test/e2e/live-loop.mjs
LOOP_GUARD_E2E_URL=... node test/e2e/live-loop.mjs --guard off   # 对照:无限重复
```

预期:guard on 时第 3 次重复提醒、第 8 次起持续 `BLOCKED`;guard off 时同一调用
无限重复。

## live-text-guard.mjs —— 生成内文本退化护栏

用 `fixtures/degenerate-context.json`(真实会话中诱发退化的上下文)发起流式
请求,输出经过(或不经过)`guardStream`:

```bash
LOOP_GUARD_E2E_URL=http://127.0.0.1:8083 node test/e2e/live-text-guard.mjs
LOOP_GUARD_E2E_URL=... node test/e2e/live-text-guard.mjs --guard off
```

预期:guard off 输出大段 "Let me X" 碎片;guard on 在重复阈值处截断
(输出含 `[loop-guard]` 标记),同响应的工具调用照常保留。

注意:模型行为有随机性,单次结果会波动;退化触发率与上下文强相关,建议各跑
2-3 次看趋势。
