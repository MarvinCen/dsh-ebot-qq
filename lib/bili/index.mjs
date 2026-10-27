/**
 * lib/bili/index.mjs —— B站 集成模块（需求 5：刷空友爱看 + 评论@人 + QQ 通知）
 * ----------------------------------------------------------------------------
 * 分工（与 dsh-bili-scroll）：
 *   - 刷「空友爱看」：bili-scroll 自己的峰谷定时器刷（它的核心能力）；
 *   - 评论里 @ 指定的人：我们通过 configEditor 把 mentionName/autoComment 同步给它；
 *   - QQ 通知：我们轮询它的日报文件（out/<日期>.md），变化即发通知给主人 ——
 *     这也是「事件驱动主动找主人」的一条腿。
 *
 * 轮询间隔 pollMinutes（默认 5）。签名存家目录，重启不重复通知。
 */
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { dayKey, readJson, writeJson, stateDirOf } from '../state.mjs'
import { syncBiliConfig, findBiliEntry } from './client.mjs'
import { reportPath, readReport, signature, extractSummary, formatNotification } from './report.mjs'

export class BiliModule {
  /**
   * @param {object} opts
   * @param {object} opts.cfg             bili 配置 { enabled, mentionName, autoComment, notifyQq, reportToQq }
   * @param {object} [opts.configEditor]  可选：拿不到就跳过配置同步（bili-scroll 没装时）
   * @param {string} opts.stateDir        bili-scroll 家目录（<DSH_HOME>/bili-duty）
   * @param {string} opts.syncFile        同步状态文件（我们的家目录里）
   * @param {string} opts.lastReportFile  已通知签名文件
   * @param {(text: string) => Promise|void} opts.notify  QQ 通知发送函数
   * @param {object} [opts.logger]
   * @param {number} [opts.pollMinutes=5]
   * @param {() => string} [opts.dayKey]  日期注入（测试）
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.cfg = opts.cfg
    this.configEditor = opts.configEditor
    this.stateDir = opts.stateDir
    this.syncFile = opts.syncFile
    this.lastReportFile = opts.lastReportFile
    this.notify = opts.notify
    this.log = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }
    this.pollMinutes = Number(opts.pollMinutes ?? 5)
    this.dayKey = opts.dayKey ?? dayKey
    this.now = opts.now ?? (() => Date.now())
    this._timer = null
    this._started = false
    // 状态文件父目录要先建好（writeJson 不负责建目录）
    for (const f of [opts.syncFile, opts.lastReportFile]) {
      try { mkdirSync(dirname(String(f)), { recursive: true }) } catch { /* 建不了写入时会再兜底 */ }
    }
  }

  start() {
    if (this._started) return
    this._started = true
    this.log.info('B站 集成已启动')
    this._syncOnce().catch((e) => this.log.warn(`启动同步失败：${e?.message ?? e}`))
    this._timer = setInterval(() => { this._pollOnce().catch((e) => this.log.warn(`轮询失败：${e?.message ?? e}`)) }, this.pollMinutes * 60_000)
    this._timer.unref?.()
  }

  dispose() {
    this._started = false
    clearInterval(this._timer)
    this._timer = null
  }

  /** 立即同步一次配置（bili-scroll 没装时静默跳过）。 */
  async syncNow() {
    if (!this.cfg.enabled) return { ok: true, synced: false, reason: '已关闭' }
    return syncBiliConfig({
      configEditor: this.configEditor,
      mentionName: this.cfg.mentionName,
      autoComment: this.cfg.autoComment,
      stateFile: this.syncFile,
      readJson,
      writeJson,
      logger: this.log,
    })
  }

  /** 立即检查一次报告（有变化就通知）。 */
  async pollNow() {
    if (!this.cfg.enabled || !this.cfg.notifyQq || this.cfg.reportToQq === 'off') return { notified: false }
    const file = reportPath(this.stateDir, this.dayKey())
    const { exists, text, mtimeMs } = readReport(file)
    if (!exists || !text.trim()) return { notified: false, exists: false }
    const sig = `${mtimeMs}:${signature(text)}`
    const prev = readJson(this.lastReportFile, {}) ?? {}
    if (prev.sig === sig) return { notified: false, unchanged: true }
    // 报告变化（新写/追加）→ 通知
    let items = []
    if (this.cfg.reportToQq === 'full') {
      await this.notify(`咕噜～今天的 B站 日报更新啦：\n${text.slice(0, 4000)}`)
    } else {
      items = extractSummary(text)
      await this.notify(formatNotification(items))
    }
    writeJson(this.lastReportFile, { sig, at: this.now() })
    this.log.info(`B站 报告已通知（${items.length} 条摘要）`)
    return { notified: true }
  }

  _syncOnce() { return this.syncNow() }
  _pollOnce() { return this.pollNow() }
}

/** 装配：接 configEditor 服务 + 主人 QQ 发送。 */
export function createBiliModule({ ctx, cfg, client, ourStateDir, logger }) {
  const configEditor = ctx?.get?.('configEditor') ?? undefined
  const biliDir = stateDirOf(ctx, 'bili-duty') // 与 bili-scroll 同一个家目录
  return new BiliModule({
    cfg: cfg.bili,
    configEditor,
    stateDir: biliDir,
    syncFile: join(ourStateDir, 'bili-sync.json'),
    lastReportFile: join(ourStateDir, 'bili-last-report.json'),
    notify: async (text) => {
      if (Number(cfg.owner.qq) > 0) await client.sendPrivateMessage(cfg.owner.qq, text)
    },
    logger,
    pollMinutes: cfg.bili.pollMinutes,
  })
}
