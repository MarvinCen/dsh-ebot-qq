# dsh-ebot-qq ｜ 大肥鱼 QQ 机器人

> 一条住在你电脑里的**大肥鱼**：会主动找你聊天、发表情包、发语音、听懂你发的语音，
> 每天刷 B站「空友爱看」并在评论里 **@ 你想 @ 的人**，还带**记忆系统** —— 越聊越懂你。

DSH 插件（host bundle），QQ 侧通过 **OneBot 11（NapCat）** 接入，
对话模型走 **OpenAI 兼容 API**（DeepSeek / OpenAI / Moonshot 等都能配）。

## 功能地图

| # | 功能 | 实现方式 | 状态 |
|---|---|---|---|
| 1 | 主动找我聊天 | 随机定时（可配时间窗）+ 事件驱动 + 按记忆与人设生成话题 | ⏳ 开发中 |
| 2 | 发表情包 | 本地表情包目录 + 语义标签，按情绪/关键词选图 | ✅ 已完成 |
| 3 | 发语音 | TTS 双引擎：Piper（本地离线）/ OpenAI 兼容 audio API（云端），用户按需选择 | ✅ 已完成 |
| 4 | 收语音 | 复用 Harness `speechToText` 转写服务，转成文字再对话 | ✅ 已完成 |
| 5 | 刷空友爱看 + 评论@人 | 复用 `dsh-bili-scroll` 的本地 HTTP API，结果通过 QQ 通知 | ⏳ 开发中 |
| 6 | 记忆系统 | 没配 embedding：短期记忆（最近对话）；配了 embedding：升级为向量检索长期记忆 | ✅ 已完成 |
| — | 日志 | 分模块日志文件 + 轮转（AGENTS.md 规则 13） | ✅ 已完成 |
| — | 配置校验 | 默认值合并 + 全字段校验，错误精确到字段路径 | ✅ 已完成 |

## 目录结构

```
├── index.js            # 插件入口（apply + Config schema）
├── cordis.patch.yml    # bundle 挂载声明
├── lib/                # 公共模块 + 各业务模块（见 lib/README.md）
├── test/               # node:test 自动化测试（每模块都有）
├── docs/               # 文档与测试用例 Excel
├── locale/             # 插件名/描述的本地化资源
└── icon.svg            # 插件图标
```

## 开发与测试

```bash
# 装依赖（用工作区自带的 Node/pnpm）
node /path/to/pnpm.mjs install

# 跑全部测试
node --test
```

> 按 AGENTS.md 规范：**每个功能都有自动化测试，全部通过才提交**；测试用例 Excel 在
> `docs/test-cases.xlsx`，表头固定为 `ID｜Category｜Scenario｜Precondition｜Request｜Expected Result｜Error Code`。

## 安装（最终用户视角）

1. 装本插件（DSH 插件管理器，选择本 bundle）→ 声明依赖会自动带上 `dsh-bili-scroll` 与运行库；
2. 机器上跑 **NapCat**（OneBot 11），在插件设置页填它的 WebSocket 地址和 token；
3. 设置页填：主人的 QQ 号、模型 API（baseUrl + key + model）、TTS 引擎、B站 @ 昵称；
4. 在「刷B站」设置页扫码登录 B站、装主依赖（第一次一次性操作）。

> ⚠️ 插件还处于开发中，以上安装流程随 Phase 推进逐步可用。
