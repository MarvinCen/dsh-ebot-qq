/**
 * lib/memory/store.mjs —— 长期记忆存储（JSON 文件持久化）
 * ----------------------------------------------------------------------------
 * 记忆条目 = 一条关于主人的事实/偏好：{ id, text, kind, createdAt, updatedAt, embedding? }
 *   - 上限 maxFacts，超出淘汰最旧（FIFO）
 *   - 文本归一化后去重（同样的话不记两遍）
 *   - 文件损坏时静默重建，绝不让记忆文件把插件带崩
 *   - 所有写操作同步落盘（记忆条数小、写入频率低，可靠性优先）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

let nextId = 1
const newId = () => `f${Date.now().toString(36)}${(nextId++).toString(36)}`

/** 文本归一化：去空白/统一大小写，用于去重与关键词检索。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

export class MemoryStore {
  /** @param {object} opts { file, maxFacts=500 } */
  constructor(opts) {
    this.file = String(opts.file)
    this.maxFacts = Number(opts.maxFacts ?? 500)
    this.facts = []
    this._load()
  }

  _load() {
    try {
      if (!existsSync(this.file)) return
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(data?.facts)) this.facts = data.facts
    } catch { this.facts = [] }
  }

  _save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ version: 1, facts: this.facts }, null, 2), 'utf8')
    } catch { /* 写不进磁盘不能炸主流程；下次写入再试 */ }
  }

  /** 全部条目（按时间正序）。 */
  list() { return [...this.facts] }

  count() { return this.facts.length }

  /**
   * 新增/合并一条记忆。
   * - 已存在同文本（归一化后）→ 更新 updatedAt 并返回已有条目（不重复记）；
   * - 超上限 → 淘汰最旧。
   */
  add(text, extra = {}) {
    const content = String(text ?? '').trim()
    if (!content) return null
    const norm = normalizeText(content)
    const existing = this.facts.find((f) => f.norm === norm)
    const now = Date.now()
    if (existing) {
      existing.updatedAt = now
      existing.embedding = extra.embedding ?? existing.embedding
      this._save()
      return existing
    }
    const fact = {
      id: newId(),
      text: content,
      kind: extra.kind ?? 'fact',
      createdAt: now,
      updatedAt: now,
      embedding: extra.embedding,
    }
    fact.norm = norm
    this.facts.push(fact)
    // 超上限淘汰最旧（FIFO）
    while (this.facts.length > this.maxFacts) this.facts.shift()
    this._save()
    return fact
  }

  /** 按 id 删除；返回是否删掉。 */
  remove(id) {
    const before = this.facts.length
    this.facts = this.facts.filter((f) => f.id !== id)
    if (this.facts.length !== before) { this._save(); return true }
    return false
  }

  /** 清空全部记忆。 */
  clear() {
    this.facts = []
    this._save()
  }
}
