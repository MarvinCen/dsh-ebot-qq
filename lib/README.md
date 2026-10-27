# lib/ —— 公共模块

插件内部所有可复用逻辑的公共层（AGENTS.md 规则 11：能复用的都抽到公共层）。

| 模块 | 职责 | 说明 |
|---|---|---|
| `logger.mjs` | 日志（AGENTS.md 规则 13） | 一个分类一个文件、级别过滤、2MB 轮转、同步落盘，详见 [logger.mjs](./logger.mjs) 头部注释 |
| `config.mjs` | 配置默认值 + 合并 + 校验 | `DEFAULT_CONFIG` 与 `index.js` 的 `Config`（schemastery）两份描述由 [test/schema-contract.test.mjs](../test/schema-contract.test.mjs) 保证一致 |
| `state.mjs` | 家目录 / JSON 读写 / 日期时间工具 | 家目录统一为 `<DSH_HOME>/ebot-qq/`，测试里传空 ctx 也可用 |

## 装配清单（index.js 的 apply 会按此顺序接入）

| Phase | 模块目录 | 状态 |
|---|---|---|
| 0 | `logger` / `config` / `state`（本目录） | ✅ 已完成 |
| 1 | `onebot/`（OneBot 11 连接） | ✅ 已完成 |
| 2 | `chat/`（LLM / 人设 / 会话 / 路由） | ✅ 已完成 |
| 3 | `memory/`（短期 + 长期 + 向量检索） | ⏳ 待做 |
| 4 | `voice/`（STT 转写 + TTS 双引擎） | ⏳ 待做 |
| 5 | `sticker/`（表情包索引与匹配） | ⏳ 待做 |
| 6 | `proactive/`（主动聊天调度） | ⏳ 待做 |
| 7 | `bili/`（复用 dsh-bili-scroll 本地 HTTP API） | ⏳ 待做 |

每个业务模块目录下都会有自己的 README.md。
