/**
 * lib/sticker/index.mjs —— 表情包模块：本地目录 + 语义标签 + 情绪匹配
 * ----------------------------------------------------------------------------
 * 标签来源（三处合并，一个文件可带多个标签）：
 *   1. 子目录名：`开心/happy.png` → 标签「开心」；
 *   2. 同目录 tags.json：{ "happy.png": ["开心", "哈哈大笑"] }；
 *   3. 文件名里的中文/英文词：`开心_happy.png` → 「开心」「happy」（下划线/空格分隔）。
 *
 * 匹配逻辑（pick）：
 *   回复文本命中内置情绪词表 → 该情绪标签池里随机一张（必发）；
 *   否则按 config.sticker.rate 概率从全池随机。
 *
 * 输出：CQ image 段用的 base64:// 引用（NapCat 最通用，不依赖本地路径可访问性）。
 */
import { readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { readJson } from '../state.mjs'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const AUTO_RESCAN_MS = 5 * 60 * 1000

/** 内置情绪词表：情绪 → 触发词。回复文本命中触发词即发该情绪的图。 */
export const EMOTION_TAGS = {
  开心: ['开心', '高兴', '哈哈', '太好了', '真棒', '恭喜'],
  难过: ['难过', '伤心', '哭', '委屈', '呜呜'],
  生气: ['生气', '气死', '烦死', '讨厌'],
  撒娇: ['撒娇', '贴贴', '抱抱', '亲亲', 'mua'],
  惊讶: ['震惊', '卧槽', '天哪', '居然', '没想到'],
  晚安: ['晚安', '睡觉', '困了'],
  干饭: ['吃饭', '干饭', '饿了', '好吃'],
}

/** 文件名 → 词单元（下划线/空格/点分隔）。 */
export function wordsFromName(name) {
  const stem = basename(name, extname(name))
  return stem.split(/[_\-\s.]+/).filter((w) => w && !/^\d+$/.test(w))
}

/** 目录扫描：返回 [{ file, name, tags:Set<string> }]。tags.json 打不开就跳过。 */
export function scanStickers(dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const tagsMap = readJson(join(dir, 'tags.json'), {})
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const item of scanStickers(join(dir, entry.name))) {
        item.tags.add(entry.name)
        out.push(item)
      }
      continue
    }
    if (!IMAGE_EXTS.has(extname(entry.name).toLowerCase())) continue
    const tags = new Set(wordsFromName(entry.name))
    const extra = tagsMap[entry.name]
    if (Array.isArray(extra)) for (const t of extra) tags.add(String(t))
    out.push({ file: join(dir, entry.name), name: entry.name, tags })
  }
  return out
}

export class StickerEngine {
  /**
   * @param {object} opts
   * @param {string} opts.dir        表情包目录
   * @param {number} [opts.rate=0.2] 未命中情绪词时的发送概率
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now] 时钟注入（测试自动重扫用）
   */
  constructor(opts) {
    this.dir = String(opts.dir || '')
    this.rate = Number(opts.rate ?? 0.2)
    this.log = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }
    this.now = opts.now ?? (() => Date.now())
    this._items = []
    this._lastScan = 0
    this._ensureDir()
    this.refresh()
  }

  _ensureDir() {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* 目录建不了就空库 */ }
  }

  /** 重新扫描目录（目录不存在 → 空库）。 */
  refresh() {
    this._items = scanStickers(this.dir)
    this._lastScan = this.now()
    this.log.info(`表情包扫描：${this._items.length} 张（${this.dir}）`)
    return this._items.length
  }

  /** 自动重扫：距上次超过 5 分钟才扫，避免每条消息都读盘。 */
  _maybeRefresh() {
    if (this.now() - this._lastScan > AUTO_RESCAN_MS) this.refresh()
  }

  /**
   * 按文本挑一张表情包，返回 CQ image 引用（base64://）或 null。
   * 命中情绪词 → 该情绪池必发；否则按 rate 概率全池随机。
   */
  pick(text) {
    this._maybeRefresh()
    if (!this._items.length) return null
    const emotion = this.matchEmotion(text)
    const pool = emotion
      ? this._items.filter((it) => it.tags.has(emotion))
      : this._items
    const candidates = pool.length ? pool : this._items
    if (emotion) return this._toBase64(candidates[Math.floor(Math.random() * candidates.length)])
    if (Math.random() >= this.rate) return null
    return this._toBase64(candidates[Math.floor(Math.random() * candidates.length)])
  }

  /** 文本 → 命中的情绪标签（最多一个，按词表顺序优先）。 */
  matchEmotion(text) {
    const src = String(text ?? '')
    for (const [emotion, words] of Object.entries(EMOTION_TAGS)) {
      if (words.some((w) => src.includes(w))) return emotion
    }
    return null
  }

  /** 按关键词找图（/表情 命令用）：文件名或标签包含词即候选。 */
  search(word) {
    this._maybeRefresh()
    if (!this._items.length) return []
    const w = String(word ?? '').toLowerCase()
    return this._items.filter((it) => it.name.toLowerCase().includes(w) || [...it.tags].some((t) => t.toLowerCase().includes(w)))
  }

  /** 随机一张（不带词的命令用）。 */
  random() {
    this._maybeRefresh()
    if (!this._items.length) return null
    return this._toBase64(this._items[Math.floor(Math.random() * this._items.length)])
  }

  _toBase64(item) {
    try {
      const buf = readFileSync(item.file)
      if (!buf.length) return null
      return 'base64://' + buf.toString('base64')
    } catch (e) {
      this.log.warn(`读表情包失败（${item.name}）：${e?.message ?? e}`)
      return null
    }
  }
}

/** 装配成 chat 的 hooks + commands。 */
export function createStickerModule({ cfg, logger, stateDir }) {
  const dir = cfg.sticker.dir || join(stateDir, 'stickers')
  const engine = new StickerEngine({ dir, rate: cfg.sticker.rate, logger })
  return {
    engine,
    hooks: {
      /** chat 挂点：按回复文本挑图（未启用/没挑中返回 undefined） */
      sticker: (replyText) => {
        if (!cfg.sticker.enabled) return undefined
        return engine.pick(replyText) ?? undefined
      },
    },
    commands: {
      表情: (_event, _peerKey, args) => {
        if (!cfg.sticker.enabled) return '表情包功能没开：去设置页把 表情包 → 启用 打开'
        const word = args.join(' ').trim()
        let ref = null
        if (word) {
          const hits = engine.search(word)
          ref = hits.length ? engine._toBase64(hits[Math.floor(Math.random() * hits.length)]) : null
        } else {
          ref = engine.random()
        }
        if (!ref) return word ? `没找到跟「${word}」有关的表情包，试试别的词～` : '鱼鱼的表情包库还是空的：把图片放进设置里配置的目录，或者 /表情 加个关键词试试'
        return { text: '', image: ref }
      },
    },
  }
}
