/**
 * lib/proactive/index.mjs —— 主动聊天引擎与装配
 * ----------------------------------------------------------------------------
 * 触发链：调度器按「随机间隔 + 时间窗」定闹钟 → 到点检查五道闸：
 *   总开关 → 主人 QQ 已配置 → 在时间窗内 → NapCat 已连接 → 冷却已过
 * → 用记忆+话题池生成开场白 → 发给主人 → 重新调度。
 *
 * 冷却：主人刚发过消息（noteOwnerActivity）后 cooldownMinutes 内不打扰，
 * 避免「刚聊完又被主动搭话」的骚扰感。
 */
import { inWindow, nextFireAt } from './scheduler.mjs'
import { pickTopic } from './topics.mjs'
import { normalizeEvent } from '../onebot/events.mjs'

export class ProactiveEngine {
  /**
   * @param {object} opts
   * @param {object} opts.cfg          proactive 配置（含 cooldownMinutes）
   * @param {number} opts.ownerQq      主人 QQ（0 = 不主动）
   * @param {() => boolean} opts.isConnected
   * @param {(text: string) => Promise|void} opts.send
   * @param {object} [opts.memory]     { recentFacts(n) => Array<{text}> }
   * @param {object} [opts.logger]
   * @param {() => number} [opts.rng]
   * @param {(now: number) => number} [opts.computeNext] 调度计算注入（测试用短间隔）
   */
  constructor(opts) {
    this.cfg = opts.cfg
    this.ownerQq = Number(opts.ownerQq ?? 0)
    this.isConnected = opts.isConnected ?? (() => true)
    this.send = opts.send
    this.memory = opts.memory
    this.log = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }
    this.rng = opts.rng ?? Math.random
    this.now = opts.now ?? (() => Date.now())
    this.computeNext = opts.computeNext ?? ((now) => nextFireAt(now, { ...this.cfg, rng: this.rng }))
    this.cooldownMs = Number(opts.cfg?.cooldownMinutes ?? 30) * 60_000
    this._timer = null
    this._started = false
    this._lastOwnerActivity = 0
    this.fireCount = 0      // 成功发送次数
    this.fireAttempts = 0   // 触发尝试次数（含被闸拦下/失败的）
  }

  start() {
    if (this._started) return
    this._started = true
    this.log.info('主动聊天已启动')
    this._schedule()
  }

  dispose() {
    this._started = false
    clearTimeout(this._timer)
    this._timer = null
    this.log.info('主动聊天已停止')
  }

  /** 主人有活动（发消息），刷新冷却起点。 */
  noteOwnerActivity() {
    this._lastOwnerActivity = this.now()
  }

  /** 此刻是否在主动聊天时间窗内。 */
  inWindowNow(now = this.now()) {
    return inWindow(now, this.cfg.windowStart, this.cfg.windowEnd)
  }

  _schedule() {
    if (!this._started) return
    const now = this.now()
    const next = this.computeNext(now)
    this._timer = setTimeout(() => { this._timer = null; this._fire() }, Math.max(50, next - now))
    this._timer.unref?.()
  }

  async _fire() {
    this.fireAttempts++
    try {
      if (!this.cfg.enabled) { this.log.debug('主动聊天已关闭，跳过'); return }
      if (!this.ownerQq) { this.log.debug('未配置主人 QQ，跳过'); return }
      if (!this.inWindowNow()) { this.log.debug('不在时间窗内，跳过'); return }
      if (!this.isConnected()) { this.log.debug('NapCat 未连接，跳过'); return }
      if (this.now() - this._lastOwnerActivity < this.cooldownMs) { this.log.debug('冷却中，跳过'); return }
      const facts = (this.memory?.recentFacts?.(3) ?? []).map((f) => f.text)
      const topic = pickTopic({ memoryFacts: facts, topics: this.cfg.topics, rng: this.rng })
      await this.send(topic)
      this.fireCount++
      this.log.info(`主动聊天已发送：${topic.slice(0, 50)}`)
    } catch (e) {
      this.log.warn(`主动聊天发送失败：${e?.message ?? e}`)
    } finally {
      this._schedule()
    }
  }
}

/** 装配：挂到 onebot 事件上（记录主人活动）+ 启动引擎。 */
export function createProactiveModule({ cfg, client, memory, logger }) {
  const engine = new ProactiveEngine({
    cfg: cfg.proactive,
    ownerQq: cfg.owner.qq,
    isConnected: () => client.state === 'connected',
    send: (text) => client.sendPrivateMessage(cfg.owner.qq, text),
    memory,
    logger,
  })
  // 主人发消息 → 冷却起点（刚聊完不主动搭话）
  const offActivity = client.onEvent((raw) => {
    const ev = normalizeEvent(raw)
    const owner = Number(cfg.owner.qq)
    if (ev.type === 'message' && ev.subType === 'private' && owner > 0 && ev.userId === owner) {
      engine.noteOwnerActivity()
    }
  })
  engine.start()
  return {
    engine,
    dispose: () => { offActivity(); engine.dispose() },
  }
}
