/**
 * lib/memory/index.mjs —— 记忆引擎：把 store/extract/retrieve 拼成 chat 要的接口
 * ----------------------------------------------------------------------------
 * 对 chat 模块暴露两个方法（见 lib/chat/router.mjs 的挂点）：
 *   retrieve(text) → 注入系统提示词的记忆文本（有 embedding 走向量，没有走关键词）
 *   remember(exchange) → 后台提取事实（限流：每 extractEvery 轮才提一次，不拖慢聊天）
 *
 * 限流是刻意的：每次聊天都调 LLM 提取太贵；每 10 轮提一次，错的漏的后面还能补。
 */
import { MemoryStore } from './store.mjs'
import { extractFacts } from './extract.mjs'
import { retrieveMemory, formatFacts } from './retrieve.mjs'

export class MemoryEngine {
  /**
   * @param {object} opts
   * @param {MemoryStore} opts.store
   * @param {object} opts.llm       LlmClient（提取事实用，与 chat 共用）
   * @param {object} opts.cfg       { longTerm, autoExtract, embedding }
   * @param {object} opts.logger    child('memory')
   * @param {number} [opts.extractEvery=10] 每多少轮对话提取一次记忆
   */
  constructor(opts) {
    this.store = opts.store
    this.llm = opts.llm
    this.cfg = opts.cfg
    this.log = opts.logger
    this.extractEvery = Number(opts.extractEvery ?? 10)
    this._exchangeCounts = new Map() // peerKey → 已交换轮数
  }

  /** chat 挂点：回复前检索记忆，返回注入文本（无长期记忆时返回空串）。 */
  async retrieve(text) {
    if (!this.cfg.longTerm) return ''
    try {
      const scored = await retrieveMemory({ query: text, store: this.store, embedding: this.cfg.embedding, logger: this.log })
      if (!scored.length) return ''
      this.log.info(`记忆检索：命中 ${scored.length} 条（query=${String(text).slice(0, 30)}）`)
      return formatFacts(scored)
    } catch (e) {
      this.log.warn(`记忆检索失败（降级为空）：${e?.message ?? e}`)
      return ''
    }
  }

  /** chat 挂点：回复后回写。限流 + 后台提取，绝不让聊天等提取。 */
  remember(exchange) {
    if (!this.cfg.longTerm || !this.cfg.autoExtract) return
    const key = String(exchange?.peerKey ?? 'global')
    const n = (this._exchangeCounts.get(key) ?? 0) + 1
    this._exchangeCounts.set(key, n)
    if (n % this.extractEvery !== 0) return
    // 后台提取（不 await）：失败已在 extractFacts 内部消化
    extractFacts(this.llm, exchange, this.log).then((facts) => {
      for (const f of facts) this.store.add(f.text, { kind: f.kind })
      this.log.info(`记忆已写入：${facts.length} 条（当前共 ${this.store.count()} 条）`)
    }).catch(() => { /* extractFacts 不抛，这里只是保险 */ })
  }

  /** /记住 命令入口：手动存一条。 */
  async addManual(text) {
    const content = String(text ?? '').trim()
    if (!content) return null
    const fact = this.store.add(content, { kind: 'fact' })
    this.log.info(`手动记忆：${content}`)
    return fact
  }

  async count() { return this.store.count() }
}
