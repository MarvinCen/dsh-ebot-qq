/**
 * test/memory-engine.test.mjs —— 记忆引擎集成测试（chat 挂点视角）
 * 覆盖：检索→注入、提取限流、手动记忆、开关关闭时的行为（测试原则 1/2/5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { MemoryStore } from '../lib/memory/store.mjs'
import { MemoryEngine } from '../lib/memory/index.mjs'
import { makeTempDir } from './helpers.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeEngine(t, opts = {}) {
  const store = new MemoryStore({ file: join(makeTempDir(t), 'facts.json'), maxFacts: 20 })
  const llm = opts.llm ?? {
    chatComplete: async () => ({ text: '[{"text":"主人喜欢喝美式","kind":"preference"}]' }),
  }
  const engine = new MemoryEngine({
    store,
    llm,
    cfg: { longTerm: true, autoExtract: true, embedding: { topK: 6 } },
    logger: quietLog,
    ...opts.engine,
  })
  return { store, llm, engine }
}

test('retrieve：命中记忆返回注入文本，未命中返回空串', async (t) => {
  const { engine } = makeEngine(t)
  assert.equal(await engine.retrieve('随便问问'), '')
  engine.store.add('主人喜欢喝美式')
  const text = await engine.retrieve('主人喜欢喝什么咖啡')
  assert.ok(text.includes('主人喜欢喝美式'))
})

test('retrieve：longTerm 关闭时直接返回空串', async (t) => {
  const { engine } = makeEngine(t, { engine: { cfg: { longTerm: false } } })
  engine.store.add('主人喜欢喝美式')
  assert.equal(await engine.retrieve('咖啡'), '')
})

test('remember：限流到第 extractEvery 轮才提取并写入', async (t) => {
  let extractCalls = 0
  const llm = {
    chatComplete: async () => { extractCalls++; return { text: '[{"text":"主人喜欢辣椒"}]' } },
  }
  const { store, engine } = makeEngine(t, { llm, engine: { extractEvery: 3 } })
  for (let i = 1; i <= 2; i++) engine.remember({ peerKey: 'p1', userText: `q${i}`, replyText: 'a' })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(extractCalls, 0, '前两轮不提取')
  assert.equal(store.count(), 0)
  engine.remember({ peerKey: 'p1', userText: 'q3', replyText: 'a' })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(extractCalls, 1, '第 3 轮提取一次')
  assert.equal(store.count(), 1)
  assert.equal(store.list()[0].text, '主人喜欢辣椒')
})

test('remember：autoExtract 关闭时不提取', async (t) => {
  let extractCalls = 0
  const llm = { chatComplete: async () => { extractCalls++; return { text: '[]' } } }
  const { engine } = makeEngine(t, { llm, engine: { cfg: { autoExtract: false }, extractEvery: 1 } })
  engine.remember({ peerKey: 'p', userText: 'q', replyText: 'a' })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(extractCalls, 0)
})

test('不同 peer 各自限流计数', async (t) => {
  let extractCalls = 0
  const llm = { chatComplete: async () => { extractCalls++; return { text: '[]' } } }
  const { engine } = makeEngine(t, { llm, engine: { extractEvery: 2 } })
  engine.remember({ peerKey: 'p1', userText: 'q', replyText: 'a' })
  engine.remember({ peerKey: 'p2', userText: 'q', replyText: 'a' })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(extractCalls, 0, '两个 peer 各 1 轮，都未到阈值')
})

test('addManual：手动记忆与 count', async (t) => {
  const { engine } = makeEngine(t)
  assert.equal(await engine.count(), 0)
  const f = await engine.addManual('主人的生日是 6 月 1 日')
  assert.equal(f.text, '主人的生日是 6 月 1 日')
  assert.equal(await engine.count(), 1)
  assert.equal(await engine.addManual('  '), null, '空白不记')
})

test('提取失败不影响聊天主流程（不抛异常）', async (t) => {
  const llm = { chatComplete: async () => { throw new Error('提取炸了') } }
  const { engine } = makeEngine(t, { llm, engine: { extractEvery: 1 } })
  assert.doesNotThrow(() => engine.remember({ peerKey: 'p', userText: 'q', replyText: 'a' }))
  await new Promise((r) => setTimeout(r, 40))
})
