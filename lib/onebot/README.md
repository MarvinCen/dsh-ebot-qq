# onebot/ —— OneBot 11 接入模块

QQ 侧协议：**OneBot 11**，一条正向 WebSocket 连接同时收事件、调 API（NapCat 默认形态）。

| 文件 | 职责 |
|---|---|
| `client.mjs` | `OneBotClient`：连接、状态机（disconnected→connecting→connected→reconnecting→disposed）、echo 关联的 API 调用（超时兜底）、指数退避重连、半死链路心跳检测、脏数据容错 |
| `events.mjs` | 事件归一化（snake_case → camelCase 内部契约）与 CQ 消息构造（`buildMessage`） |

## 内部契约（给上层模块）

- 事件经 `normalizeEvent(raw)` 后长这样：
  ```js
  { type: 'message', subType: 'private'|'group', messageId, userId,
    groupId?, senderName, text, segments, raw }
  ```
  业务层只认 camelCase；协议端字段差异只在 `events.mjs` 里消化。
- API 错误统一是 `OneBotError`，带稳定 `code`：
  `EBOT-NOT-CONNECTED` / `EBOT-API-TIMEOUT` / `EBOT-DISPOSED` / `EBOT-API-<retcode>` / `EBOT-SEND-FAILED`。

## 配置对应

`config.onebot.*`：`url`（ws:// 或 wss://）、`token`（access_token，追加到 URL query）、
`apiTimeoutMs`、`reconnectBaseMs/MaxMs`（指数退避区间）。
