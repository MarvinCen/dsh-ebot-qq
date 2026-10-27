# memory/ —— 记忆系统模块

按配置自动分级（用户需求：没配 embedding 时只有短期记忆，配了才有向量检索）：

| 文件 | 职责 |
|---|---|
| `store.mjs` | `MemoryStore`：长期记忆 JSON 持久化（去重合并 / FIFO 淘汰 / 损坏容错） |
| `extract.mjs` | LLM 提取事实：对话 → `[{text, kind}]`，解析全容错，失败返回 [] |
| `retrieve.mjs` | 检索：配齐 embedding 三件套 → 向量余弦 topK+minScore；否则 → 关键词打分（整词+二字窗口） |
| `index.mjs` | `MemoryEngine`：组装 store/extract/retrieve，提供 chat 挂点 `retrieve()` / `remember()` / `addManual()` |

## 与短期记忆的分工

- **短期记忆**（`lib/chat/session.mjs`）：最近 N 轮对话原文，直接进上下文，`/清空` 可清；
- **长期记忆**（本模块）：从对话里提取的事实/偏好，跨会话持久化，注入系统提示词，`/记住 xxx` 手动加。

## 提取限流

`remember()` 每 `extractEvery` 轮（默认 10）才调一次 LLM 提取 —— 聊天不等待提取，提取在后台跑。

## 错误码

`EBOT-EMB-HTTP-<status>` / `EBOT-EMB-EMPTY`（embedding 调用失败走日志，检索降级为空串，不炸聊天）。
