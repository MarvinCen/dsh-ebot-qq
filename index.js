/**
 * dsh-ebot-qq —— 「大肥鱼」QQ 机器人插件（host 半端）
 * ============================================================================
 * 一条鱼，六件事：
 *   1. 主动找你聊天（随机定时 + 事件驱动 + 按记忆和人设生成话题）
 *   2. 发表情包（本地表情包目录 + 语义标签，按情绪/关键词选图）
 *   3. 发语音（TTS：Piper 本地 / OpenAI 兼容云端，用户按需选择）
 *   4. 收语音（复用 Harness speechToText 转写服务）
 *   5. 刷 B站 空友爱看并在评论里 @ 指定的人（复用 dsh-bili-scroll 的能力），
 *      刷完把结果通过 QQ 通知主人
 *   6. 记忆系统：没配 embedding 时只有短期记忆；配了 embedding 升级为
 *      带向量检索的长期记忆
 *
 * QQ 侧协议：OneBot 11（NapCat 正向 WebSocket，一条连接同时收事件、调 API）。
 * 对话模型：OpenAI 兼容 chat API（DeepSeek / OpenAI / Moonshot 等都可配）。
 * ============================================================================
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { stateDirOf } from './lib/state.mjs'
import { createLogger } from './lib/logger.mjs'
import { resolveConfig } from './lib/config.mjs'
import { OneBotClient } from './lib/onebot/client.mjs'
import { LlmClient } from './lib/chat/llm.mjs'
import { SessionStore } from './lib/chat/session.mjs'
import { ChatEngine } from './lib/chat/router.mjs'
import { MemoryStore } from './lib/memory/store.mjs'
import { MemoryEngine } from './lib/memory/index.mjs'

// ⚠️ schemastery 彻底拿不到时这里是 undefined —— 插件照常加载，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活）。
//    🔴 规则（实测）：
//       - 每个**叶子**字段都要 .extra('volatile', true)，DSH settings.update() 只认 volatile 字段；
//       - 中间对象**不能**标 volatile（schemastery 会拒收「volatile 嵌套 volatile」）；
//       - apiKey/token 这类秘密标 role=secret：设置页只写不读，值不会跨边界回传。
let z
try { z = (await import('@deepseek-ai/schemastery')).default } catch { /* 设置页降级 */ }

export const Config = !z ? undefined : z.object({
  onebot: z.object({
    url: z.string().default('ws://127.0.0.1:3001').extra('volatile', true),
    token: z.string().default('').extra('volatile', true).extra('role', 'secret'),
    apiTimeoutMs: z.natural().default(10000).extra('volatile', true),
    reconnectBaseMs: z.natural().default(2000).extra('volatile', true),
    reconnectMaxMs: z.natural().default(60000).extra('volatile', true),
  }),
  owner: z.object({
    qq: z.natural().default(0).extra('volatile', true),
    groups: z.array(z.string()).default([]).extra('volatile', true),
  }),
  llm: z.object({
    baseUrl: z.string().default('https://api.deepseek.com/v1').extra('volatile', true),
    apiKey: z.string().default('').extra('volatile', true).extra('role', 'secret'),
    model: z.string().default('deepseek-chat').extra('volatile', true),
    temperature: z.number().default(0.9).extra('volatile', true),
    maxTokens: z.natural().default(512).extra('volatile', true),
    timeoutMs: z.natural().default(60000).extra('volatile', true),
  }),
  persona: z.object({
    name: z.string().default('大肥鱼').extra('volatile', true),
    prompt: z.string().default('').extra('volatile', true),
  }),
  memory: z.object({
    shortTermTurns: z.natural().default(10).extra('volatile', true),
    longTerm: z.boolean().default(true).extra('volatile', true),
    maxFacts: z.natural().default(500).extra('volatile', true),
    autoExtract: z.boolean().default(true).extra('volatile', true),
    embedding: z.object({
      baseUrl: z.string().default('').extra('volatile', true),
      apiKey: z.string().default('').extra('volatile', true).extra('role', 'secret'),
      model: z.string().default('').extra('volatile', true),
      topK: z.natural().default(6).extra('volatile', true),
      minScore: z.number().default(0.45).extra('volatile', true),
    }),
  }),
  voice: z.object({
    sttEnabled: z.boolean().default(true).extra('volatile', true),
    tts: z.object({
      provider: z.string().default('off').extra('volatile', true),
      piper: z.object({
        bin: z.string().default('').extra('volatile', true),
        model: z.string().default('').extra('volatile', true),
        voiceConfig: z.string().default('').extra('volatile', true),
      }),
      openai: z.object({
        baseUrl: z.string().default('').extra('volatile', true),
        apiKey: z.string().default('').extra('volatile', true).extra('role', 'secret'),
        model: z.string().default('tts-1').extra('volatile', true),
        voice: z.string().default('alloy').extra('volatile', true),
        format: z.string().default('mp3').extra('volatile', true),
      }),
    }),
  }),
  sticker: z.object({
    enabled: z.boolean().default(true).extra('volatile', true),
    dir: z.string().default('').extra('volatile', true),
  }),
  proactive: z.object({
    enabled: z.boolean().default(true).extra('volatile', true),
    windowStart: z.string().default('09:00').extra('volatile', true),
    windowEnd: z.string().default('23:00').extra('volatile', true),
    minIntervalHours: z.number().default(2).extra('volatile', true),
    maxIntervalHours: z.number().default(6).extra('volatile', true),
    topics: z.array(z.string()).default([]).extra('volatile', true),
  }),
  bili: z.object({
    enabled: z.boolean().default(true).extra('volatile', true),
    mentionName: z.string().default('').extra('volatile', true),
    autoComment: z.boolean().default(true).extra('volatile', true),
    notifyQq: z.boolean().default(true).extra('volatile', true),
    reportToQq: z.string().default('summary').extra('volatile', true),
  }),
  log: z.object({
    level: z.string().default('info').extra('volatile', true),
    dir: z.string().default('').extra('volatile', true),
  }),
})

/**
 * 插件入口。各模块在后续 Phase 里逐个装配进来：
 *   logger（Phase 0）→ onebot（Phase 1）→ chat（Phase 2）→
 *   memory → voice → sticker → proactive → bili
 */
export function apply(ctx, config) {
  const { config: cfg, errors } = resolveConfig(config)
  const stateDir = stateDirOf(ctx)
  const logger = createLogger({
    dir: cfg.log.dir || join(stateDir, 'logs'),
    level: cfg.log.level,
  })

  logger.info(`大肥鱼 QQ 机器人 v${PKG_VERSION} 已挂载（家=${stateDir}）`)
  for (const e of errors) logger.warn(`配置校验未通过：${e.path} —— ${e.message}`)
  if (!Config) logger.warn('schemastery 不可用：设置页降级，插件功能不受影响')
  if (!cfg.llm.apiKey) logger.warn('llm.apiKey 未配置：聊天会失败，请在设置页填写')

  // ── 会话（短期记忆）与 LLM 客户端 ──
  const sessions = new SessionStore({ shortTermTurns: cfg.memory.shortTermTurns })
  const llm = new LlmClient({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    timeoutMs: cfg.llm.timeoutMs,
    logger: logger.child('llm'),
  })

  // ── 长期记忆（无 embedding 走关键词检索；配齐三件套升级为向量检索）──
  const memory = new MemoryEngine({
    store: new MemoryStore({ file: join(stateDir, 'memory', 'facts.json'), maxFacts: cfg.memory.maxFacts }),
    llm,
    cfg: { longTerm: cfg.memory.longTerm, autoExtract: cfg.memory.autoExtract, embedding: cfg.memory.embedding },
    logger: logger.child('memory'),
  })

  // ── OneBot 连接 + 聊天引擎（后续 Phase 的 memory/voice/sticker hooks 从这里插）──
  const client = new OneBotClient({
    url: cfg.onebot.url,
    token: cfg.onebot.token,
    apiTimeoutMs: cfg.onebot.apiTimeoutMs,
    reconnectBaseMs: cfg.onebot.reconnectBaseMs,
    reconnectMaxMs: cfg.onebot.reconnectMaxMs,
    logger: logger.child('onebot'),
  })
  const chatEngine = new ChatEngine({
    client,
    llm,
    sessions,
    cfg: { persona: cfg.persona, owner: cfg.owner },
    logger: logger.child('chat'),
    memory,
    commands: {
      // 手动记忆：/记住 主人的生日是6月1日
      记住: async (_event, _peerKey, args) => {
        if (!args.length) return '鱼鱼要记住什么呀？'
        const fact = await memory.addManual(args.join(' '))
        return fact ? `咕噜，记住了：「${fact.text}」` : '这句话好像不用记哦'
      },
    },
  })
  chatEngine.attach()
  client.start()

  // 收摊顺序：先摘聊天引擎（中断在途生成），再断连接
  ctx.effect(() => () => {
    chatEngine.dispose()
    client.dispose()
    logger.info('大肥鱼 QQ 机器人已卸载')
  }, 'ebot-qq: 卸载收摊')
}

/** 版本号（package.json 的 version），避免在代码里再写一遍。 */
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '0.0.0' }
})()
