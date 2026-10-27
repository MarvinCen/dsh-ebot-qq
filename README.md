# dsh-ebot-qq ｜ 大肥鱼 QQ 机器人

> 一条住在你电脑里的**大肥鱼**：会主动找你聊天、发表情包、发语音、听懂你发的语音，
> 每天刷 B站「空友爱看」并在评论里 **@ 你想 @ 的人**，还带**记忆系统** —— 越聊越懂你。

DSH 插件（host bundle）。QQ 侧通过 **OneBot 11（NapCat）** 接入，
对话模型走 **OpenAI 兼容 API**（DeepSeek / OpenAI / Moonshot 等都能配）。

## 功能地图

| # | 功能 | 实现方式 | 状态 |
|---|---|---|---|
| 1 | 主动找我聊天 | 随机定时（时间窗可配、支持跨夜）+ 冷却 + 按记忆与人设生成话题 | ✅ |
| 2 | 发表情包 | 本地表情包目录 + 语义标签（子目录/tags.json/文件名），按情绪/关键词选图 | ✅ |
| 3 | 发语音 | TTS 双引擎：Piper（本地离线）/ OpenAI 兼容 audio API（云端） | ✅ |
| 4 | 收语音 | 复用 Harness `speechToText` 转写服务，转成文字再对话 | ✅ |
| 5 | 刷空友爱看 + 评论@人 | 复用 `dsh-bili-scroll`：configEditor 同步@昵称，轮询日报发 QQ 通知 | ✅ |
| 6 | 记忆系统 | 没配 embedding：短期+关键词长期记忆；配了 embedding：向量检索长期记忆 | ✅ |
| — | 日志 | 分模块日志文件 + 2MB 轮转（AGENTS.md 规则 13） | ✅ |

## 安装与首次使用

1. **装插件**：DSH 插件管理器装本 bundle（自动带上 `dsh-bili-scroll` 依赖）。
2. **装 NapCat**（QQ 协议端，一次性）：
   - 下载并登录 [NapCat](https://github.com/NapNeko/NapCatQQ)（用它自己的 QQ 号登录，需在 WebUi 里配置）；
   - 网络配置里开启 **WebSocket 服务器**（正向 WS，默认 `ws://127.0.0.1:3001`），可选设 access_token；
   - 把地址与 token 填进本插件设置页「OneBot」。
3. **模型**：设置页「LLM」填 baseUrl + API Key + 模型名（如 DeepSeek：`https://api.deepseek.com/v1`）。
4. **主人 QQ**：设置页「主人」填你的 QQ 号（只回你；群聊需加白名单群号）。
5. **B站**：进「刷B站」设置页 → 装主依赖 + 扫码登录（选「记住我」）；本插件设置页「B站」填评论要 @ 的昵称。
6. **表情包**：往设置页「表情包 → 目录」里放图（按情绪建子文件夹效果最好，可选 tags.json）。
7. **语音**：发语音默认开（走 Harness 转写）；回语音选 TTS 引擎（Piper 需下载模型，见 `lib/voice/README.md`）。

## 命令（QQ 里发）

| 命令 | 作用 |
|---|---|
| `/帮助` | 命令列表 |
| `/状态` | 连接状态、会话数、长期记忆条数 |
| `/清空` | 清当前会话的短期记忆（长期记忆不动） |
| `/记住 xxx` | 手动写一条长期记忆 |
| `/语音 一句话` | 立刻发一段语音 |
| `/表情 [关键词]` | 随机/按词发一张表情包 |
| `/刷视频` | 同步 B站 @ 配置并说明刷站流程 |

## 目录结构

```
├── index.js            # 插件入口（apply + Config schema）
├── cordis.patch.yml    # bundle 挂载声明
├── lib/                # 公共层 + 各业务模块（onebot/chat/memory/voice/sticker/proactive/bili）
├── test/               # node:test 测试（185 个，含 mock NapCat 的端到端闭环）
├── docs/               # test-cases.json + test-cases.xlsx（测试用例 Excel）
├── scripts/gen_testcases.py  # 从 JSON 重建 Excel
├── locale/             # 本地化（zh/en）
└── icon.svg            # 插件图标
```

## 开发与测试

```bash
# 装依赖（用工作区自带的 Node/pnpm）
node /path/to/pnpm.mjs install

# 跑全部测试（185 个；模块测试 + mock NapCat/LLM 的端到端测试）
node --test
```

> 规范：每个功能都有自动化测试，**全部通过才提交**；测试用例 Excel 表头固定为
> `ID｜Category｜Scenario｜Precondition｜Request｜Expected Result｜Error Code`（`docs/test-cases.xlsx`）。

## 常见问题

- **插件一直打印「断线重连」**：NapCat 没开或地址不对。配置好 NapCat 前属正常，不会影响其他功能。
- **聊天回复「鱼鱼走神了」软文案**：LLM 配置错了（key/baseUrl/model），看日志 `logs/llm.log`。
- **收到语音回「没听清」**：Harness 转写服务未就绪/不支持该音频格式。
- **B站 没 @ 人**：确认「刷B站」已扫码登录、本插件「B站 → @ 昵称」已填（`/刷视频` 会做一次同步检查）。
- **想看它到底干了什么**：全部日志在 `~/.dsh/ebot-qq/logs/`（app/onebot/chat/memory/voice/sticker/proactive/bili/llm 分类文件）。
