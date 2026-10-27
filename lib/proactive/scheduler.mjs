/**
 * lib/proactive/scheduler.mjs —— 主动聊天的调度纯函数
 * ----------------------------------------------------------------------------
 * 窗口（windowStart/windowEnd）支持跨夜（如 22:00–02:00）。
 * 调度策略：now + 随机间隔（min~max 小时）；结果落在窗口外就顺延到
 * 下一个窗口内的随机点。rng 可注入，全部逻辑可确定性单测。
 */

const MS_HOUR = 3600_000
const MS_DAY = 24 * MS_HOUR

function msOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * MS_HOUR + m * 60_000
}

function startOfDay(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 此刻是否在时间窗内（跨夜窗口按「开始→次日结束」理解）。 */
export function inWindow(nowMs, windowStart, windowEnd) {
  const start = msOf(windowStart)
  const end = msOf(windowEnd)
  const t = nowMs - startOfDay(nowMs) // 当天已过毫秒数
  if (end > start) return t >= start && t < end
  // 跨夜（如 22:00–02:00）：当天 [start, 24:00) 或次日 [00:00, end) 都算
  return t >= start || t < end
}

/**
 * 计算下一次主动聊天的时刻（毫秒时间戳）。
 * @param {number} nowMs 当前时间
 * @param {object} opts { windowStart, windowEnd, minIntervalHours, maxIntervalHours, rng }
 */
export function nextFireAt(nowMs, opts) {
  const rng = opts.rng ?? Math.random
  const min = Number(opts.minIntervalHours) * MS_HOUR
  const max = Math.max(min, Number(opts.maxIntervalHours) * MS_HOUR)
  const interval = min + (max - min) * rng()
  let t = nowMs + interval
  const start = startOfDay(t) + msOf(opts.windowStart)
  const end = startOfDay(t) + msOf(opts.windowEnd)
  const winStart = start
  const winEnd = end > start ? end : end + MS_DAY
  if (t < winStart || t >= winEnd) {
    t = winStart + rng() * (winEnd - winStart)
  }
  return t
}
