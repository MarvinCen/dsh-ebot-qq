/**
 * lib/chat/router.mjs —— 聊天引擎：把「一条 QQ 消息」变成「一次大肥鱼的回复」
 * ----------------------------------------------------------------------------
 * 编排顺序：
 *   权限判定（主人私聊 / 白名单群 @鱼）→ 命令分流 → 忙检查 → 记忆检索 →
 *   拼 prompt（人设 + 短期历史 + 长期记忆）→ LLM → 分段发送 → 回写短期历史。
 *
 * 挂点（hooks）：表情包 / 语音 / 长期记忆这些能力以 hook 形式插进来，
 * 本模块不 import 它们 —— 后续 Phase 的模块只在这里注册，避免循环依赖。
 */
import { normalizeEvent, buildMessage } from '../onebot/events.mjs'
import { buildSystemPrompt } from './persona.mjs'

const SOFT_FALLBACKS = [
  '咕噜……鱼鱼刚才走神了，没听清，再说一次好不好？',
  '噗噜，鱼鱼刚刚打了个盹，主人再说一遍嘛～',
  '吐泡泡……鱼鱼脑子进水了（不是），刚才没反应过来，重来一次！',
]

const HELP_TEXT = [
  '咕噜！我是大肥鱼，会这些：',
  '· /帮助 —— 看这个列表',
  '· /状态 —— 看看鱼鱼记得多少东西、连没连上',
  '· /清空 —— 清掉咱俩的聊天记录（短期记忆）',
  '· 直接聊天就行，鱼鱼会回复、发表情包、发语音（看你配置）',
].join('\n')

/** 把长文本按句子边界切成不超过 max 的段（QQ 单条消息有长度上限）。 */
export function splitLongText(text, max = 4000) {
  const src = String(text ?? '')
  if (src.length <= max) return [src]
  const parts = []
  let rest = src
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0 || cut < max / 2) {
      // 没有换行点就找句号；再没有就硬切
      cut = rest.lastIndexOf('。', max)
      if (cut <= 0 || cut < max / 2) cut = max
      else cut += 1
    }
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

/** 触发关键词：群聊里 @鱼 或提到这些词才回。 */
const MENTION_WORDS = ['大肥鱼', '鱼鱼']

export class ChatEngine {
  /**
   * @param {object} opts
   * @param {object} opts.client     OneBotClient
   * @param {object} opts.llm        LlmClient
   * @param {object} opts.sessions   SessionStore
   * @param {object} opts.cfg        { persona:{name,prompt}, owner:{qq,groups}, memory? }
   * @param {object} opts.logger     child('chat') 日志器
   * @param {object} [opts.memory]   memory 模块接口 { retrieve(text)=>Promise<string>, remember(exchange)=>void }（Phase 3 接入）
   * @param {object} [opts.hooks]    { sticker?(replyText, ctx)=>Promise<image|undefined>, voice?(replyText, ctx)=>Promise<record|undefined> }
   */
  constructor(opts) {
    this.client = opts.client
    this.llm = opts.llm
    this.sessions = opts.sessions
    this.cfg = opts.cfg
    this.log = opts.logger
    this.memory = opts.memory
    this.hooks = opts.hooks ?? {}
    this.selfId = null
    this._busy = new Set()   // peerKey 正在生成回复中
    this._abort = new Map()  // peerKey → AbortController
    this._off = null
  }

  /** 订阅 onebot 事件（幂等）。 */
  attach() {
    if (this._off) return
    this._off = this.client.onEvent((raw) => {
      const event = normalizeEvent(raw)
      if (event.type === 'meta') {
        if (raw?.meta_event_type === 'lifecycle' && raw?.self_id) this.selfId = raw.self_id
        return
      }
      if (event.type === 'message') this.handleMessage(event).catch((e) => this.log.error(`消息处理出错：${e?.stack ?? e}`))
    })
  }

  /** 卸载事件订阅并中断在途生成。 */
  dispose() {
    this._off?.()
    this._off = null
    for (const [, ctrl] of this._abort) ctrl.abort()
    this._abort.clear()
  }

  /** 这条消息鱼鱼要不要回。 */
  shouldReply(event) {
    if (event.subType === 'private') {
      const owner = Number(this.cfg.owner?.qq ?? 0)
      return owner === 0 || event.userId === owner
    }
    // 群聊：白名单群 且（@了鱼 或 提到关键词）
    const groups = new Set((this.cfg.owner?.groups ?? []).map(String))
    if (!groups.has(String(event.groupId))) return false
    if (this.selfId && event.segments.some((s) => s?.type === 'at' && String(s.data?.qq) === String(this.selfId))) return true
    return MENTION_WORDS.some((w) => event.text.includes(w))
  }

  async handleMessage(event) {
    if (!this.shouldReply(event)) return
    const peerKey = event.subType === 'group'
      ? `group:${event.groupId}`
      : `private:${event.userId}`
    const text = event.text.trim()

    // 纯命令（不记入会话历史）
    if (text.startsWith('/')) return this._handleCommand(event, peerKey, text)

    if (!text) {
      this.log.info(`收到无文本消息（${peerKey}），暂不回复`)
      return
    }
    if (this._busy.has(peerKey)) {
      await this._send(event, '鱼鱼还在想上一句，咕噜……稍等一下下～')
      return
    }

    this._busy.add(peerKey)
    const ctrl = new AbortController()
    this._abort.set(peerKey, ctrl)
    try {
      const replyText = await this._generate(peerKey, text, ctrl.signal)
      const decorated = await this._decorate(replyText, event, peerKey)
      for (const piece of splitLongText(decorated.text)) {
        await this._send(event, { ...decorated, text: piece })
      }
      this.sessions.push(peerKey, 'user', text)
      this.sessions.push(peerKey, 'assistant', replyText)
      this.memory?.remember?.({ peerKey, userText: text, replyText })
    } catch (err) {
      if (err?.code === 'EBOT-LLM-CANCELLED') { this.log.info(`回复已取消（${peerKey}）`) ; return }
      this.log.error(`生成回复失败（${peerKey}）：${err?.stack ?? err}`)
      await this._send(event, SOFT_FALLBACKS[Math.floor(Math.random() * SOFT_FALLBACKS.length)])
    } finally {
      this._busy.delete(peerKey)
      this._abort.delete(peerKey)
    }
  }

  /** 拼 prompt 并调用 LLM。 */
  async _generate(peerKey, text, signal) {
    const memoryText = this.memory ? await this.memory.retrieve(text) : ''
    const system = buildSystemPrompt({
      name: this.cfg.persona?.name,
      prompt: this.cfg.persona?.prompt,
      memoryText,
    })
    const messages = [
      { role: 'system', content: system },
      ...this.sessions.history(peerKey),
      { role: 'user', content: text },
    ]
    this.log.info(`→ 模型（${peerKey}，历史 ${messages.length - 2} 条）：${text.slice(0, 60)}`)
    const { text: reply } = await this.llm.chatComplete({ messages, signal })
    this.log.info(`← 模型（${peerKey}）：${reply.slice(0, 60)}`)
    return reply
  }

  /** 表情包/语音装饰：hooks 提供的附加媒体放进回复里。 */
  async _decorate(replyText, event, peerKey) {
    const out = { text: replyText }
    const ctx = { event, peerKey }
    try {
      if (this.hooks.sticker) {
        const image = await this.hooks.sticker(replyText, ctx)
        if (image) out.image = image
      }
      if (this.hooks.voice) {
        const record = await this.hooks.voice(replyText, ctx)
        if (record) out.record = record
      }
    } catch (e) { this.log.warn(`装饰 hook 出错：${e?.message ?? e}`) }
    return out
  }

  /** 发送：私聊/群聊分派。纯文本直接发字符串；带媒体才拼 CQ 段。 */
  async _send(event, payload) {
    const hasMedia = payload.image !== undefined || payload.record !== undefined || payload.atUser !== undefined
    const message = typeof payload === 'string' || !hasMedia
      ? (typeof payload === 'string' ? payload : payload.text)
      : buildMessage({ text: payload.text, image: payload.image, record: payload.record, atUser: payload.atUser })
    if (event.subType === 'group') {
      await this.client.sendGroupMessage(event.groupId, message)
    } else {
      await this.client.sendPrivateMessage(event.userId, message)
    }
  }

  async _handleCommand(event, peerKey, text) {
    const [cmd, ...args] = text.slice(1).split(/\s+/)
    switch (cmd) {
      case '帮助':
      case 'help':
        return this._send(event, HELP_TEXT)
      case '状态':
      case 'status': {
        const lines = [
          `咕噜，这里是 ${this.cfg.persona?.name ?? '大肥鱼'} 的状态：`,
          `· 连接：${this.client.state === 'connected' ? '连着 NapCat ✅' : `没连上（${this.client.state}）❌`}`,
          `· 会话数：${this.sessions.size}`,
        ]
        if (this.memory) lines.push(`· 长期记忆：${await this.memory.count()} 条`)
        return this._send(event, lines.join('\n'))
      }
      case '清空':
      case 'clear':
        this.sessions.clear(peerKey)
        return this._send(event, '噗噜～鱼鱼把咱俩刚才聊的忘掉啦（长期记忆不受影响）')
      default:
        return this._send(event, '鱼鱼没学过这个命令，试试 /帮助 吧')
    }
  }
}
