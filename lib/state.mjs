/**
 * lib/state.mjs —— 公共状态/文件小工具
 * ----------------------------------------------------------------------------
 * 插件运行期需要落在磁盘上的所有东西（日志、记忆、配置快照等）都放在
 * 「插件家目录」`<DSH_HOME>/ebot-qq/` 下，绝不写进插件包目录。
 *
 * stateDirOf(ctx) 的取值顺序照搬 dsh-bili-scroll 里验证过的写法：
 *   ctx.get('dshHomePath') 可能是**函数**（形如 dshHomePath(...seg) => join(home, ...seg)），
 *   也可能直接是字符串；都拿不到时退回 $DSH_HOME / ~/.dsh。
 */
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 解析插件家目录并确保存在。ctx 可为空（测试里直接传 null）。 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('ebot-qq')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'ebot-qq')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ebot-qq')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 读 JSON 文件；不存在或损坏时返回 fallback，绝不抛错。 */
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 写 JSON 文件（美化缩进）。 */
export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 今天（本地时区）的 YYYY-MM-DD，用于报告/判重文件名。 */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** ISO 时间戳（含毫秒），日志行统一用它。 */
export function nowIso(date = new Date()) {
  return date.toISOString()
}

/** 确保目录存在（含父级），幂等。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 文件存在性检查（顺手封装，避免到处 import fs）。 */
export function fileExists(file) {
  return existsSync(file)
}
