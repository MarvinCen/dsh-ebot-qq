/**
 * lib/logger.mjs —— 日志模块（AGENTS.md 规则 13）
 * ----------------------------------------------------------------------------
 * 设计要点：
 *  1. 一个「分类（category）」一个日志文件，落在 `<logsDir>/<category>.log`，
 *     例如 app.log / onebot.log / chat.log / memory.log / voice.log / bili.log，
 *     出问题时按模块定位，不用在一锅粥里捞。
 *  2. 每条日志固定格式：`2026-10-27T04:00:00.123Z [INFO] [chat] 消息`。
 *  3. 级别过滤：debug(10) < info(20) < warn(30) < error(40)，只落 >= 配置级别的行。
 *  4. 文件轮转：超过 maxBytes（默认 2MB）滚成 `<file>.1`，只留一份旧档，防无声膨胀。
 *  5. 同步追加（appendFileSync）：聊天机器人场景日志量小，可靠性优先；
 *     写入失败只吞掉（记到 console），绝不能因为日志把主流程带崩。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** 把消息统一成单行字符串（对象走 JSON，避免 [object Object]）。 */
function stringify(msg) {
  if (typeof msg === 'string') return msg.replace(/\r?\n/g, ' ↵ ')
  try { return JSON.stringify(msg) } catch { return String(msg) }
}

/**
 * 创建日志器。
 * @param {object} opts
 * @param {string} opts.dir    日志目录（会自动创建）
 * @param {string} [opts.level='info']  最低落盘级别
 * @param {number} [opts.maxBytes=2*1024*1024] 单文件轮转阈值（测试里可调小）
 * @param {boolean} [opts.consoleMirror=true]  同步镜像到控制台
 * @returns 带 debug/info/warn/error/child 的日志器
 */
export function createLogger(opts) {
  const dir = String(opts?.dir || '')
  const level = String(opts?.level || 'info').toLowerCase()
  const threshold = LEVELS[level] ?? LEVELS.info
  const maxBytes = Number(opts?.maxBytes) || 2 * 1024 * 1024
  const consoleMirror = opts?.consoleMirror !== false

  // 日志目录建不起来（路径是文件 / 没权限）时降级为「只打控制台」，
  // 绝不能因为日志模块把插件启动带崩。
  let dirOk = true
  try { mkdirSync(dir, { recursive: true }) } catch { dirOk = false }

  /** 核心写入：级别过滤 → 轮转检查 → 追加一行。 */
  function write(category, lv, msg) {
    if (LEVELS[lv] < threshold) return
    const line = `${new Date().toISOString()} [${lv.toUpperCase()}] [${category}] ${stringify(msg)}`
    if (dirOk) {
      const file = join(dir, `${category}.log`)
      rotateIfNeeded(file)
      try { appendFileSync(file, line + '\n', 'utf8') } catch { /* 写不进日志不能炸主流程 */ }
    }
    if (consoleMirror) {
      if (lv === 'error' || lv === 'warn') console.error(line)
      else console.log(line)
    }
  }

  /** 超过阈值就滚成 .1（只留一份旧档）。 */
  function rotateIfNeeded(file) {
    try {
      if (statSync(file).size < maxBytes) return
      rmSync(file + '.1', { force: true })
      renameSync(file, file + '.1')
    } catch { /* 文件不存在/删不掉都不算错 */ }
  }

  /** 一个分类的一组方法。 */
  function categoryLogger(category) {
    return {
      debug: (msg) => write(category, 'debug', msg),
      info: (msg) => write(category, 'info', msg),
      warn: (msg) => write(category, 'warn', msg),
      error: (msg) => write(category, 'error', msg),
    }
  }

  const app = categoryLogger('app')
  return {
    ...app,
    /** 派生一个模块分类日志器，例如 child('chat')。 */
    child: categoryLogger,
  }
}
