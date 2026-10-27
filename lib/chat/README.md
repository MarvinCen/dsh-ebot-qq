# chat/ —— 对话核心模块

一条 QQ 消息进来 → 一条大肥鱼回复出去的全部编排。

| 文件 | 职责 |
|---|---|
| `llm.mjs` | `LlmClient`：OpenAI 兼容 chat 补全。4xx 不重试、5xx/网络/超时指数退避重试、reasoning 模型兼容、稳定错误码 |
| `persona.mjs` | 内置默认人设（大肥鱼）+ `buildSystemPrompt`（日期 / 自定义人设 / 长期记忆动态注入） |
| `session.mjs` | `SessionStore`：短期记忆窗口（按轮数裁剪、多会话隔离、容量淘汰） |
| `router.mjs` | `ChatEngine`：权限 → 命令 → 忙检查 → 记忆检索 → LLM → 分段发送 → 回写历史 |

## 错误码（LlmError.code）

`EBOT-LLM-HTTP-<status>` / `EBOT-LLM-HTTP-5XX` / `EBOT-LLM-TIMEOUT` / `EBOT-LLM-NETWORK` /
`EBOT-LLM-EMPTY` / `EBOT-LLM-CANCELLED`。用户侧永远只看到软文案，错误码只进日志。

## 回复资格

- 私聊：`owner.qq = 0` 时谁都回；否则只回主人；
- 群聊：`owner.groups` 白名单内，且（@了鱼 或 提到「大肥鱼/鱼鱼」）才回。

## 扩展挂点（后续 Phase 注册）

- `hooks.sticker(replyText, ctx)` → 返回 image 文件引用，随回复一起发；
- `hooks.voice(replyText, ctx)` → 返回 record 文件引用，随回复一起发；
- `memory.retrieve(text)` / `memory.remember(exchange)` —— 长期记忆接入点（Phase 3）。

## 命令

`/帮助`、`/状态`、`/清空`（清短期记忆，不动长期记忆）。
