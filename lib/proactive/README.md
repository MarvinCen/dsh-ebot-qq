# proactive/ —— 主动聊天模块

鱼鱼「主动找你聊天」的实现：随机定时 + 时间窗 + 冷却 + 记忆驱动话题。

| 文件 | 职责 |
|---|---|
| `scheduler.mjs` | 纯函数：`inWindow`（支持跨夜窗口）、`nextFireAt`（随机间隔 + 窗口外顺延），rng 可注入 |
| `topics.mjs` | 话题生成：长期记忆最近事实 → 钩子句式（60% 概率）；否则内置话题池 + 用户自定义话题随机 |
| `index.mjs` | `ProactiveEngine`（五道闸：总开关/主人配置/时间窗/连接状态/冷却）+ 装配（监听主人消息刷新冷却） |

## 触发规则

- 每次触发后按 `minIntervalHours~maxIntervalHours` 随机间隔再调度；落在时间窗外自动顺延到窗口内随机点；
- 主人刚发过消息（`cooldownMinutes`，默认 30 分钟内）不主动搭话，避免骚扰感；
- 时间窗支持跨夜（如 22:00–02:00）。

## 事件驱动

本模块负责「定时主动聊」。事件驱动的另一条腿（刷 B站 发现好视频 → 主动 QQ 通知）在 `lib/bili` 里（Phase 7）。

## 配置对应

`proactive.enabled / windowStart / windowEnd / minIntervalHours / maxIntervalHours / cooldownMinutes / topics`。
