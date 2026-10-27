/**
 * lib/onebot/client.mjs —— OneBot 11 正向 WebSocket 客户端
 * ----------------------------------------------------------------------------
 * 一条连接干两件事：
 *   - 收事件：message / notice / request / meta_event（无 echo 字段的包就是事件）；
 *   - 调 API：发 { action, params, echo }，等同名 echo 的响应包。
 *
 * 状态机（显式建模，AGENTS.md 测试原则 4）：
 *   disconnected ──start()──▶ connecting ──open──▶ connected
 *   connecting/connected ──close/error（未 dispose）──▶ reconnecting
 *   reconnecting ──退避到期──▶ connecting
 *   任意状态 ──dispose()──▶ disposed（终态，不再重连）
 *
 * 可靠性设计：
 *   - 断线重连：指数退避 base→max，每次成功重连重置退避；
 *   - 半死链路检测：周期 ping，超时未 pong 就 terminate 触发重连；
 *   - API 调用：echo 关联 + 超时兜底；未连接时立即失败，不傻等；
 *   - 脏数据（非 JSON、不认识的事件）只记日志，绝不让一条坏包带崩连接。
 */
import WebSocket from 'ws'

export const ONE_BOT_STATES = ['disconnected', 'connecting', 'connected', 'reconnecting', 'disposed']

/** 带稳定 code 的错误，方便上层按错误码分支（AGENTS.md 规则：错误码可测）。 */
export class OneBotError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OneBotError'
    this.code = code
  }
}

let echoSeq = 0
const nextEcho = () => `ebot-${Date.now().toString(36)}-${++echoSeq}`

/**
 * 指数退避延迟（纯函数，便于确定性单测）。
 * delay = min(base * 2^retry, max)，再加 ±jitterRatio 的随机抖动。
 */
export function reconnectDelay(retry, base, max, jitterRatio = 0.2) {
  const b = Math.max(1, Number(base) || 1)
  const m = Math.max(b, Number(max) || b)
  const r = Math.max(0, Number(retry) || 0)
  const delay = Math.min(b * 2 ** r, m)
  const ratio = Math.min(1, Math.max(0, Number(jitterRatio) || 0))
  const jitter = delay * ratio * Math.random()
  return Math.round(delay + jitter)
}

export class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.url              ws:// 或 wss:// 地址（可带 query）
   * @param {string} [opts.token]          access_token，非空时追加到 URL query
   * @param {number} [opts.apiTimeoutMs]   API 调用超时（毫秒）
   * @param {number} [opts.reconnectBaseMs] 重连退避基数
   * @param {number} [opts.reconnectMaxMs]  重连退避上限
   * @param {number} [opts.pingIntervalMs]  半死检测 ping 间隔（0 = 关闭）
   * @param {number} [opts.jitterRatio]     退避抖动比例（0~1，测试里传 0 便于断言）
   * @param {object} [opts.logger]         lib/logger.mjs 的日志器（child('onebot') 传入）
   */
  constructor(opts) {
    this.url = String(opts.url)
    this.token = String(opts.token || '')
    this.apiTimeoutMs = Number(opts.apiTimeoutMs) || 10000
    this.reconnectBaseMs = Number(opts.reconnectBaseMs) || 2000
    this.reconnectMaxMs = Number(opts.reconnectMaxMs) || 60000
    this.pingIntervalMs = Number(opts.pingIntervalMs) || 30000
    this.jitterRatio = Number(opts.jitterRatio) || 0
    this.log = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }

    this._state = 'disconnected'
    this._ws = null
    this._disposed = false
    this._reconnectTimer = null
    this._pingTimer = null
    this._lastPongAt = 0
    this._retry = 0                       // 连续重连次数（成功连上即清零）
    this._pending = new Map()             // echo → { resolve, reject, timer }
    this._eventHandlers = []              // (event) => Promise<void> | void
    this.stateHistory = []                // 状态迁移流水（调试与测试断言用）
  }

  get state() { return this._state }

  _setState(next) {
    if (this._state === next) return
    const prev = this._state
    this._state = next
    this.stateHistory.push(next)
    this.log.info(`连接状态：${prev} → ${next}`)
  }

  /** 启动：开始连接循环。幂等（已启动/已 dispose 时直接返回）。 */
  start() {
    if (this._disposed || this._ws) return
    this._connect()
  }

  /** 停止：断开当前连接、取消重连、失败所有在途调用。终态。 */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    this._setState('disposed')
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._stopPing()
    const ws = this._ws
    this._ws = null
    if (ws) {
      try { ws.close() } catch { /* 已关 */ }
      try { ws.terminate() } catch { /* 已断 */ }
    }
    this._failAllPending(new OneBotError('EBOT-DISPOSED', '客户端已停止'))
  }

  /** 注册事件处理器；返回取消函数。处理器抛错只记日志，不影响其他处理器。 */
  onEvent(handler) {
    this._eventHandlers.push(handler)
    return () => {
      const i = this._eventHandlers.indexOf(handler)
      if (i >= 0) this._eventHandlers.splice(i, 1)
    }
  }

  /** 调 OneBot API：resolve 为响应里的 data 字段。 */
  callApi(action, params = {}) {
    if (this._disposed) return Promise.reject(new OneBotError('EBOT-DISPOSED', '客户端已停止'))
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new OneBotError('EBOT-NOT-CONNECTED', `未连接，无法调用 ${action}`))
    }
    const echo = nextEcho()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo)
        reject(new OneBotError('EBOT-API-TIMEOUT', `API ${action} 超时（${this.apiTimeoutMs}ms）`))
      }, this.apiTimeoutMs)
      this._pending.set(echo, { resolve, reject, timer, action })
      this.log.debug(`→ ${action} ${JSON.stringify(params).slice(0, 200)} (${echo})`)
      try { this._ws.send(JSON.stringify({ action, params, echo })) } catch (e) {
        clearTimeout(timer)
        this._pending.delete(echo)
        reject(new OneBotError('EBOT-SEND-FAILED', `发送 ${action} 失败：${e?.message ?? e}`))
      }
    })
  }

  /** 便捷封装：常用发送接口。 */
  sendPrivateMessage(userId, message) { return this.callApi('send_private_msg', { user_id: userId, message }) }
  sendGroupMessage(groupId, message) { return this.callApi('send_group_msg', { group_id: groupId, message }) }

  // ─────────────────────────── 内部：连接循环 ───────────────────────────

  _connect() {
    if (this._disposed) return
    this._setState('connecting')
    let url = this.url
    if (this.token) {
      url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.token)
    }
    const ws = new WebSocket(url)
    this._ws = ws
    ws.on('open', () => {
      if (this._disposed) { try { ws.close() } catch { /* 收摊 */ } return }
      this._retry = 0
      this._setState('connected')
      this.log.info(`已连接 ${url.replace(/access_token=[^&]*/, 'access_token=***')}`)
      this._startPing()
    })
    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary))
    ws.on('pong', () => { this._lastPongAt = Date.now() })
    ws.on('error', (err) => {
      // error 后必跟 close，这里只记日志，收尾交给 close 统一处理
      this.log.warn(`连接错误：${err?.message ?? err}`)
    })
    ws.on('close', (code, reason) => {
      if (this._ws !== ws) return
      this._ws = null
      this._stopPing()
      this._failAllPending(new OneBotError('EBOT-NOT-CONNECTED', `连接已断开（code=${code}）`))
      if (this._disposed) return
      this._scheduleReconnect()
    })
  }

  _scheduleReconnect() {
    if (this._disposed || this._reconnectTimer) return
    this._setState('reconnecting')
    const delay = reconnectDelay(this._retry, this.reconnectBaseMs, this.reconnectMaxMs, this.jitterRatio)
    this._retry++
    this.log.info(`断线重连：第 ${this._retry} 次，${delay}ms 后重试`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connect()
    }, delay)
  }

  async _onMessage(data, isBinary) {
    if (isBinary) return
    let raw
    try { raw = JSON.parse(data.toString()) } catch {
      this.log.warn(`收到非 JSON 包，已忽略（前 80 字：${String(data).slice(0, 80)}）`)
      return
    }
    if (typeof raw.echo === 'string' && this._pending.has(raw.echo)) {
      const { resolve, reject, timer, action } = this._pending.get(raw.echo)
      clearTimeout(timer)
      this._pending.delete(raw.echo)
      if (raw.status === 'ok') {
        this.log.debug(`← ${action} 成功 (${raw.echo})`)
        resolve(raw.data)
      } else {
        this.log.warn(`← ${action} 失败 (${raw.echo})：${raw.retcode} ${raw.message ?? ''}`)
        reject(new OneBotError(`EBOT-API-${raw.retcode ?? 'FAILED'}`, `${action} 失败：${raw.message ?? raw.retcode}`))
      }
      return
    }
    // 无 echo = 服务端事件，逐个处理器顺序分发（保序），异常不扩散
    for (const handler of this._eventHandlers) {
      try { await handler(raw) } catch (e) { this.log.error(`事件处理出错：${e?.stack ?? e}`) }
    }
  }

  _startPing() {
    if (!this.pingIntervalMs) return
    this._lastPongAt = Date.now()
    this._pingTimer = setInterval(() => {
      const ws = this._ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // 半死链路：上一拍 pong 超时两倍间隔未回 → 掐断触发重连
      if (Date.now() - this._lastPongAt > this.pingIntervalMs * 2) {
        this.log.warn('心跳超时，链路疑似半死，强制断开重连')
        try { ws.terminate() } catch { /* 已断 */ }
        return
      }
      try { ws.ping() } catch { /* 发送失败由 close 收尾 */ }
    }, this.pingIntervalMs)
    this._pingTimer.unref?.()
  }

  _stopPing() {
    clearInterval(this._pingTimer)
    this._pingTimer = null
  }

  _failAllPending(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this._pending.clear()
  }
}
