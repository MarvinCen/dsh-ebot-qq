/**
 * lib/chat/session.mjs —— 会话（短期记忆窗口）管理
 * ----------------------------------------------------------------------------
 * 每个聊天对象（私聊 QQ 号 / 群号）一条独立会话，互不串味。
 * 窗口按「轮数」裁剪：一问一答 = 1 轮 = 2 条消息，超出 shortTermTurns 轮的最旧消息丢弃。
 * 这是 memory 模块之外的短期层 —— 长期记忆（事实/偏好/向量检索）在 lib/memory 里。
 */

/** 单个 peer 的会话上限保护（防止恶意灌水把内存撑爆）。 */
const MAX_MESSAGES_PER_PEER = 200
const MAX_CHARS_PER_MESSAGE = 4000

export class SessionStore {
  /**
   * @param {object} opts
   * @param {number} [opts.shortTermTurns=10] 窗口轮数
   * @param {number} [opts.maxPeers=500]      最多同时保留多少个会话
   */
  constructor(opts = {}) {
    this.shortTermTurns = Number(opts.shortTermTurns ?? 10)
    this.maxPeers = Number(opts.maxPeers ?? 500)
    this._map = new Map() // peerKey → [{ role, content }]
  }

  /** peerKey 规范形式：私聊 `private:<qq>`，群聊 `group:<gid>`。 */
  static privateKey(qq) { return `private:${qq}` }
  static groupKey(gid) { return `group:${gid}` }

  /** 记一条消息（user 或 assistant），并顺手裁剪窗口。 */
  push(peerKey, role, content) {
    if (role !== 'user' && role !== 'assistant') throw new TypeError(`未知角色 ${role}`)
    const text = String(content ?? '').slice(0, MAX_CHARS_PER_MESSAGE)
    if (!text.trim()) return
    if (!this._map.has(peerKey)) this._evictIfNeeded()
    const list = this._map.get(peerKey) ?? []
    list.push({ role, content: text })
    // 窗口裁剪：保留最近 shortTermTurns 轮（x2 条）
    const keep = this.shortTermTurns * 2
    if (list.length > keep) list.splice(0, list.length - keep)
    this._map.set(peerKey, list)
  }

  /** 取某会话的历史（不含系统提示词），按时间顺序。 */
  history(peerKey) {
    return [...(this._map.get(peerKey) ?? [])]
  }

  /** 清空某会话（/清空 命令用）。 */
  clear(peerKey) {
    this._map.delete(peerKey)
  }

  /** 会话数（测试/状态用）。 */
  get size() {
    return this._map.size
  }

  _evictIfNeeded() {
    if (this._map.size < this.maxPeers) return
    // 淘汰最久没动过的那条（Map 迭代序 = 插入序，第一个就是最老的）
    const oldest = this._map.keys().next().value
    if (oldest !== undefined) this._map.delete(oldest)
  }
}
