# bili/ —— B站 集成模块（刷空友爱看 + 评论@人 + QQ 通知）

与 **dsh-bili-scroll**（声明为本 bundle 依赖）分工协作：

| 职责 | 谁干 | 怎么接的 |
|---|---|---|
| 刷「空友爱看」 | bili-scroll 的峰谷定时器 | 用户在其设置页扫码登录 + 装依赖（一次性） |
| 评论里 @ 指定的人 | bili-scroll 执行 | 我们通过 **`configEditor` 服务**把 `mentionName`/`autoComment` 热同步到它的配置条目（带变化检测，不反复写） |
| 刷完通知 QQ | 我们 | 轮询它的日报文件 `<DSH_HOME>/bili-duty/out/<日期>.md`，签名变化即发 QQ 通知（summary 摘要 / full 全文 / off） |

| 文件 | 职责 |
|---|---|
| `client.mjs` | `findBiliEntry` + `syncBiliConfig`（configEditor 同步，官方路径，避开 bili-scroll 自带的 HTTP 信任栅栏） |
| `report.mjs` | 日报读取、内容签名、`### BV` 块摘要解析、通知文案格式化 |
| `index.mjs` | `BiliModule`（轮询 + 同步 + 生命周期）+ 装配 |

## 为什么不直接调它的 HTTP API

`/api/bili-duty/*` 挂了 DSH 信任栅栏，只认浏览器会话（实测 loopback 无 cookie 请求 401）。
配置文件直接读、配置条目走 configEditor —— 都是官方且不被栅栏拦的路。

## 配置对应

`bili.enabled / mentionName / autoComment / notifyQq / reportToQq（summary|full|off）/ pollMinutes`。
QQ 侧命令：`/刷视频`（同步配置并给出引导）。
