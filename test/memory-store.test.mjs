/**
 * test/memory-store.test.mjs —— 长期记忆存储测试
 * 覆盖：增/合并/删/清空、上限淘汰、持久化读回、损坏文件容错（测试原则 3/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { MemoryStore, normalizeText } from '../lib/memory/store.mjs'
import { makeTempDir } from './helpers.mjs'

test('新增与列表', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  const store = new MemoryStore({ file })
  const f = store.add('主人喜欢喝美式')
  assert.equal(store.count(), 1)
  assert.equal(f.text, '主人喜欢喝美式')
  assert.equal(f.kind, 'fact')
  assert.equal(store.list()[0].text, '主人喜欢喝美式')
})

test('同义文本合并（归一化去重），不重复记', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  const store = new MemoryStore({ file })
  store.add('主人 喜欢 喝美式')
  const again = store.add('主人喜欢喝美式')
  assert.equal(store.count(), 1, '空白差异应视为同一条')
  assert.equal(again.id, store.list()[0].id)
})

test('删除与清空', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  const store = new MemoryStore({ file })
  const f1 = store.add('a')
  store.add('b')
  assert.equal(store.remove(f1.id), true)
  assert.equal(store.count(), 1)
  assert.equal(store.remove('不存在'), false)
  store.clear()
  assert.equal(store.count(), 0)
})

test('上限淘汰：超出 maxFacts 淘汰最旧', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  const store = new MemoryStore({ file, maxFacts: 3 })
  for (let i = 1; i <= 5; i++) store.add(`事实${i}`)
  assert.equal(store.count(), 3)
  assert.deepEqual(store.list().map((f) => f.text), ['事实3', '事实4', '事实5'])
})

test('持久化：重建实例后读回', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  const a = new MemoryStore({ file })
  a.add('主人养了只猫', { kind: 'fact', embedding: [0.1, 0.2] })
  const b = new MemoryStore({ file })
  assert.equal(b.count(), 1)
  assert.equal(b.list()[0].text, '主人养了只猫')
  assert.deepEqual(b.list()[0].embedding, [0.1, 0.2])
})

test('失败路径：文件损坏时静默重建', (t) => {
  const file = join(makeTempDir(t), 'facts.json')
  writeFileSync(file, '{{{不是JSON', 'utf8')
  const store = new MemoryStore({ file })
  assert.equal(store.count(), 0)
  store.add('新的开始')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).facts.length, 1, '损坏文件应被修复重写')
})

test('normalizeText：空白折叠 + 小写', () => {
  assert.equal(normalizeText(' 主人 喜欢  A '), '主人喜欢a')
  assert.equal(normalizeText(''), '')
})
