/**
 * lib/config.mjs —— 配置默认值、合并与校验
 * ----------------------------------------------------------------------------
 * 两份描述要保持一致（有契约测试盯着）：
 *   - 本文件的 DEFAULT_CONFIG：运行期真正生效的默认值；
 *   - index.js 里导出的 Config（schemastery）：设置页展示/写入用的 schema。
 *
 * 校验只在这里做：无论配置从哪来（cordis row / 设置页 / 本地 config.json 覆盖），
 * 进业务模块前都先过 resolveConfig()。校验失败不阻断启动 —— 错误清单交给上层打日志，
 * 让用户能看到「哪个字段哪里不对」，而不是整条插件静默失效。
 */

export const DEFAULT_CONFIG = {
  onebot: {
    /** NapCat 正向 WebSocket 地址（插件主动连它，事件和 API 都走这一条） */
    url: 'ws://127.0.0.1:3001',
    /** NapCat 网络配置里设置的 access_token，没设就留空 */
    token: '',
    apiTimeoutMs: 10000,
    reconnectBaseMs: 2000,
    reconnectMaxMs: 60000,
  },
  owner: {
    /** 主人的 QQ 号（0 = 没填，主动聊天等主人向功能会跳过） */
    qq: 0,
    /** 允许响应的群号列表；空 = 不响应任何群（私聊为主） */
    groups: [],
  },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.9,
    maxTokens: 512,
    timeoutMs: 60000,
  },
  persona: {
    name: '大肥鱼',
    /** 留空 = 用内置默认人设（见 chat/persona.mjs） */
    prompt: '',
  },
  memory: {
    /** 短期记忆：带进上下文的最大对话轮数（一问一答算一轮） */
    shortTermTurns: 10,
    /** 长期记忆总开关（事实/偏好抽取与注入） */
    longTerm: true,
    maxFacts: 500,
    autoExtract: true,
    embedding: {
      /** 三件套都填了才有向量检索；缺一个就退回「最近 + 关键词」检索 */
      baseUrl: '',
      apiKey: '',
      model: '',
      topK: 6,
      minScore: 0.45,
    },
  },
  voice: {
    /** 收到语音时是否用 Harness 转写服务转文字（false = 收到语音只回「听不清」） */
    sttEnabled: true,
    /** 回复语音模式：off = 不发语音 / on = 每条回复都带语音 / smart = 短回复（<=80字）才带 */
    mode: 'off',
    tts: {
      /** off | piper（本地）| openai（云端兼容协议） */
      provider: 'off',
      piper: {
        /** piper 可执行文件路径；留空 = 自动找 PATH 里的 piper */
        bin: '',
        /** .onnx 模型文件路径（必填，见 voice/README.md 的下载指引） */
        model: '',
        voiceConfig: '',
      },
      openai: {
        baseUrl: '',
        apiKey: '',
        model: 'tts-1',
        voice: 'alloy',
        format: 'mp3',
      },
    },
  },
  sticker: {
    enabled: true,
    /** 表情包目录；留空 = 用插件家目录里的 stickers/ */
    dir: '',
    /** 回复时附带表情包的概率（0~1）；命中情绪关键词时必发 */
    rate: 0.2,
  },
  proactive: {
    enabled: true,
    /** 主动聊天时间窗（本地时间），窗口外绝不主动发消息 */
    windowStart: '09:00',
    windowEnd: '23:00',
    minIntervalHours: 2,
    maxIntervalHours: 6,
    /** 主人刚发过消息后的冷却分钟数（刚聊完不打扰） */
    cooldownMinutes: 30,
    /** 内置话题池之外的补充话题，一行一个 */
    topics: [],
  },
  bili: {
    enabled: true,
    /** 刷空友爱看时，评论里 @ 的 B站昵称（空 = 不 @，只通知 QQ） */
    mentionName: '',
    /** 开自动评论（由 dsh-bili-scroll 执行；要先在它的设置页扫码登录 B站） */
    autoComment: true,
    /** 刷完一轮后把结果发到 QQ 通知主人 */
    notifyQq: true,
    /** 发到 QQ 的报告形态：summary = 精简摘要 / full = 整份报告 / off = 不发 */
    reportToQq: 'summary',
    /** 轮询报告变化的间隔（分钟） */
    pollMinutes: 5,
  },
  log: {
    level: 'info',
    /** 日志目录；留空 = 插件家目录 logs/ */
    dir: '',
  },
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const LEVELS = ['debug', 'info', 'warn', 'error']
const TTS_PROVIDERS = ['off', 'piper', 'openai']
const VOICE_MODES = ['off', 'on', 'smart']
const REPORT_MODES = ['summary', 'full', 'off']

/** cosmokit volatile 字段的标记符号（与 schemastery 实例化输出一致）。 */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 把 cordis 传来的配置还原成纯值：volatile 字段在 apply 的 config 参数里是
 * { get(), [VOLATILE_WRITE] } 的包装对象（实测 String() 会得到 [object Object]），
 * 递归解包（与 dsh-settings 的 plainConfig 同语义）。
 */
export function plainConfig(v) {
  if (v && typeof v === 'object') {
    if (VOLATILE_WRITE in v) return plainConfig(v.get())
    const out = Array.isArray(v) ? [] : {}
    for (const k of Object.keys(v)) out[k] = plainConfig(v[k])
    return out
  }
  return v
}

/** 纯函数：把校验不通过的项收集成 { path, message }。 */
export function validateConfig(cfg) {
  const errors = []
  const err = (path, message) => errors.push({ path, message })

  const isStr = (v) => typeof v === 'string'
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
  const isPosInt = (v) => Number.isInteger(v) && v > 0

  if (!isStr(cfg.onebot.url) || !/^wss?:\/\//.test(cfg.onebot.url)) {
    err('onebot.url', '必须是 ws:// 或 wss:// 开头的地址')
  }
  if (!isStr(cfg.onebot.token)) err('onebot.token', '必须是字符串')
  for (const k of ['apiTimeoutMs', 'reconnectBaseMs', 'reconnectMaxMs']) {
    if (!isPosInt(cfg.onebot[k])) err(`onebot.${k}`, '必须是正整数（毫秒）')
  }
  if (cfg.onebot.reconnectMaxMs < cfg.onebot.reconnectBaseMs) {
    err('onebot.reconnectMaxMs', '不能小于 reconnectBaseMs')
  }

  if (!Number.isInteger(cfg.owner.qq) || cfg.owner.qq < 0) err('owner.qq', '必须是 0 或正整数 QQ 号')
  if (!Array.isArray(cfg.owner.groups) || cfg.owner.groups.some((g) => typeof g !== 'string')) {
    err('owner.groups', '必须是字符串数组（群号列表）')
  }

  if (!isStr(cfg.llm.baseUrl) || !cfg.llm.baseUrl.trim()) err('llm.baseUrl', '不能为空')
  if (!isStr(cfg.llm.apiKey)) err('llm.apiKey', '必须是字符串')
  if (!isStr(cfg.llm.model) || !cfg.llm.model.trim()) err('llm.model', '不能为空')
  if (!isNum(cfg.llm.temperature) || cfg.llm.temperature < 0 || cfg.llm.temperature > 2) {
    err('llm.temperature', '必须在 0~2 之间')
  }
  if (!isPosInt(cfg.llm.maxTokens)) err('llm.maxTokens', '必须是正整数')
  if (!isPosInt(cfg.llm.timeoutMs)) err('llm.timeoutMs', '必须是正整数（毫秒）')

  if (!isStr(cfg.persona.name) || !cfg.persona.name.trim()) err('persona.name', '不能为空')
  if (!isStr(cfg.persona.prompt)) err('persona.prompt', '必须是字符串')

  if (!Number.isInteger(cfg.memory.shortTermTurns) || cfg.memory.shortTermTurns < 0) {
    err('memory.shortTermTurns', '必须是 0 或正整数（轮数）')
  }
  if (typeof cfg.memory.longTerm !== 'boolean') err('memory.longTerm', '必须是布尔值')
  if (!isPosInt(cfg.memory.maxFacts)) err('memory.maxFacts', '必须是正整数')
  if (typeof cfg.memory.autoExtract !== 'boolean') err('memory.autoExtract', '必须是布尔值')
  const emb = cfg.memory.embedding
  for (const k of ['baseUrl', 'apiKey', 'model']) {
    if (!isStr(emb[k])) err(`memory.embedding.${k}`, '必须是字符串')
  }
  if (!Number.isInteger(emb.topK) || emb.topK < 1) err('memory.embedding.topK', '必须是 >=1 的整数')
  if (!isNum(emb.minScore) || emb.minScore < 0 || emb.minScore > 1) {
    err('memory.embedding.minScore', '必须在 0~1 之间')
  }

  if (typeof cfg.voice.sttEnabled !== 'boolean') err('voice.sttEnabled', '必须是布尔值')
  if (!VOICE_MODES.includes(cfg.voice.mode)) {
    err('voice.mode', `必须是 ${VOICE_MODES.join(' / ')} 之一`)
  }
  if (!TTS_PROVIDERS.includes(cfg.voice.tts.provider)) {
    err('voice.tts.provider', `必须是 ${TTS_PROVIDERS.join(' / ')} 之一`)
  }
  if (!isStr(cfg.voice.tts.piper.bin)) err('voice.tts.piper.bin', '必须是字符串')
  if (!isStr(cfg.voice.tts.piper.model)) err('voice.tts.piper.model', '必须是字符串')
  if (!isStr(cfg.voice.tts.piper.voiceConfig)) err('voice.tts.piper.voiceConfig', '必须是字符串')
  if (cfg.voice.tts.provider === 'piper' && !cfg.voice.tts.piper.model.trim()) {
    err('voice.tts.piper.model', 'provider=piper 时必须填模型文件路径')
  }
  const oai = cfg.voice.tts.openai
  for (const k of ['baseUrl', 'apiKey', 'model', 'voice', 'format']) {
    if (!isStr(oai[k])) err(`voice.tts.openai.${k}`, '必须是字符串')
  }
  if (cfg.voice.tts.provider === 'openai') {
    if (!oai.baseUrl.trim()) err('voice.tts.openai.baseUrl', 'provider=openai 时必须填 baseUrl')
    if (!oai.apiKey.trim()) err('voice.tts.openai.apiKey', 'provider=openai 时必须填 apiKey')
  }

  if (typeof cfg.sticker.enabled !== 'boolean') err('sticker.enabled', '必须是布尔值')
  if (!isStr(cfg.sticker.dir)) err('sticker.dir', '必须是字符串')
  if (!isNum(cfg.sticker.rate) || cfg.sticker.rate < 0 || cfg.sticker.rate > 1) {
    err('sticker.rate', '必须在 0~1 之间')
  }

  if (typeof cfg.proactive.enabled !== 'boolean') err('proactive.enabled', '必须是布尔值')
  if (!TIME_RE.test(cfg.proactive.windowStart)) {
    err('proactive.windowStart', '必须是 HH:mm 格式（00:00~23:59）')
  }
  if (!TIME_RE.test(cfg.proactive.windowEnd)) {
    err('proactive.windowEnd', '必须是 HH:mm 格式（00:00~23:59）')
  }
  if (cfg.proactive.windowStart === cfg.proactive.windowEnd) {
    err('proactive.windowEnd', '不能和 windowStart 相同（窗口为空）')
  }
  if (!isPosInt(cfg.proactive.minIntervalHours)) err('proactive.minIntervalHours', '必须是正整数（小时）')
  if (!isNum(cfg.proactive.maxIntervalHours) || cfg.proactive.maxIntervalHours < cfg.proactive.minIntervalHours) {
    err('proactive.maxIntervalHours', '必须 >= minIntervalHours')
  }
  if (!Number.isInteger(cfg.proactive.cooldownMinutes) || cfg.proactive.cooldownMinutes < 0) {
    err('proactive.cooldownMinutes', '必须是 0 或正整数（分钟）')
  }
  if (!Array.isArray(cfg.proactive.topics) || cfg.proactive.topics.some((t) => typeof t !== 'string')) {
    err('proactive.topics', '必须是字符串数组')
  }

  if (typeof cfg.bili.enabled !== 'boolean') err('bili.enabled', '必须是布尔值')
  if (!isStr(cfg.bili.mentionName)) err('bili.mentionName', '必须是字符串')
  if (typeof cfg.bili.autoComment !== 'boolean') err('bili.autoComment', '必须是布尔值')
  if (typeof cfg.bili.notifyQq !== 'boolean') err('bili.notifyQq', '必须是布尔值')
  if (!REPORT_MODES.includes(cfg.bili.reportToQq)) {
    err('bili.reportToQq', `必须是 ${REPORT_MODES.join(' / ')} 之一`)
  }
  if (!isPosInt(cfg.bili.pollMinutes)) err('bili.pollMinutes', '必须是正整数（分钟）')

  if (!LEVELS.includes(cfg.log.level)) err('log.level', `必须是 ${LEVELS.join(' / ')} 之一`)
  if (!isStr(cfg.log.dir)) err('log.dir', '必须是字符串')

  return errors
}

/** 深合并：普通对象递归合并，数组/标量以 override 为准。 */
export function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (typeof base !== 'object' || typeof override !== 'object') return override
  const out = { ...base }
  for (const key of Object.keys(override)) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key]
  }
  return out
}

/**
 * 合并默认值 + 校验。返回 { config, errors }，errors 为空即通过。
 * 字符串字段顺手 trim（apiKey/路径等不留首尾空格）。
 */
export function resolveConfig(raw) {
  const config = deepMerge(DEFAULT_CONFIG, raw ?? {})
  // 字符串字段统一安全 trim：非字符串输入原样保留，交给 validateConfig 报类型错误，
  // 绝不能在这里抛 TypeError 把插件启动带崩。
  const s = (v) => (typeof v === 'string' ? v.trim() : v)
  const trimmed = {
    ...config,
    onebot: { ...config.onebot, url: s(config.onebot.url), token: s(config.onebot.token) },
    llm: { ...config.llm, baseUrl: s(config.llm.baseUrl), apiKey: s(config.llm.apiKey), model: s(config.llm.model) },
    persona: { ...config.persona, name: s(config.persona.name), prompt: s(config.persona.prompt) },
    memory: {
      ...config.memory,
      embedding: {
        ...config.memory.embedding,
        baseUrl: s(config.memory.embedding.baseUrl),
        apiKey: s(config.memory.embedding.apiKey),
        model: s(config.memory.embedding.model),
      },
    },
    voice: {
      ...config.voice,
      tts: {
        ...config.voice.tts,
        piper: {
          ...config.voice.tts.piper,
          bin: s(config.voice.tts.piper.bin),
          model: s(config.voice.tts.piper.model),
          voiceConfig: s(config.voice.tts.piper.voiceConfig),
        },
        openai: {
          ...config.voice.tts.openai,
          baseUrl: s(config.voice.tts.openai.baseUrl),
          apiKey: s(config.voice.tts.openai.apiKey),
          model: s(config.voice.tts.openai.model),
          voice: s(config.voice.tts.openai.voice),
          format: s(config.voice.tts.openai.format),
        },
      },
    },
    sticker: { ...config.sticker, dir: s(config.sticker.dir) },
    proactive: { ...config.proactive, topics: Array.isArray(config.proactive.topics) ? config.proactive.topics.map(s) : config.proactive.topics },
    bili: { ...config.bili, mentionName: s(config.bili.mentionName) },
    log: { ...config.log, dir: s(config.log.dir) },
  }
  return { config: trimmed, errors: validateConfig(trimmed) }
}
