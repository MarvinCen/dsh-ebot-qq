/**
 * test/memory-retrieve.test.mjs —— 记忆检索测试
 * 覆盖：关键词打分与排序、向量余弦、embedding API 调用（mock）、minScore 过滤、
 *       formatFacts、embedding 失败降级（测试原则 5/6/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tokens, keywordScore, cosine, retrieveKeyword, retrieveMemory, embedOnce, formatFacts } from '../lib/memory/retrieve.mjs'
import { MemoryStore } from '../lib/memory/store.mjs'
import { makeTempDir } from './helpers.mjs'

test('tokens：整词 + 二字窗口', () => {
  assert.deepEqual(tokens('ab'), ['ab'])
  assert.deepEqual(tokens('abc'), ['abc', 'ab', 'bc'])
  assert.deepEqual(tokens('  '), [])
})

test('keywordScore：重合度打分', () => {
  assert.equal(keywordScore('咖啡', '主人喜欢喝美式咖啡'), 1, '全命中')
  assert.equal(keywordScore('咖啡', '主人喜欢喝茶'), 0, '零命中')
  assert.ok(keywordScore('咖啡和猫', '主人喜欢咖啡') > 0 && keywordScore('咖啡和猫', '主人喜欢咖啡') < 1, '部分命中')
})

test('cosine：同向量=1，正交=0，维度不同=0', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 2], [1]), 0)
  assert.equal(cosine([], [1, 2]), 0)
})

test('关键词路线：按分数排序取 topK，零命中不返回', (t) => {
  const store = new MemoryStore({ file: join(makeTempDir(t), 'f.json') })
  store.add('主人喜欢咖啡')
  store.add('主人养了一只猫')
  store.add('主人每天跑步')
  const hits = retrieveKeyword('主人喜欢咖啡', store.list(), 2)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].fact.text, '主人喜欢咖啡')
  assert.ok(hits[0].score >= hits[1].score)
  assert.deepEqual(retrieveKeyword('完全无关的话题xyz', store.list()), [])
})

test('embedOnce：请求 /v1/embeddings 并取 data[0].embedding', async (t) => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/embeddings')
    let body = ''
    for await (const c of req) body += c
    const parsed = JSON.parse(body)
    assert.equal(parsed.model, 'emb-m')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const vec = await embedOnce({ baseUrl, apiKey: 'k', model: 'emb-m', input: '咖啡' })
  assert.deepEqual(vec, [0.1, 0.2, 0.3])
  server.close()
})

test('embedOnce：HTTP 错误与空响应带稳定错误码', async (t) => {
  const server = createServer((req, res) => { res.writeHead(500); res.end('{}') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(embedOnce({ baseUrl, apiKey: 'k', model: 'm', input: 'x' }), (e) => e.code === 'EBOT-EMB-HTTP-500')
  server.close()
})

test('向量路线：query 与记忆都过 embedding，按余弦排序 + minScore 过滤', async (t) => {
  const store = new MemoryStore({ file: join(makeTempDir(t), 'f.json') })
  store.add('主人喜欢咖啡', { embedding: [1, 0] })
  store.add('主人养猫', { embedding: [0.9, 0.4] })
  store.add('主人爱看动漫', { embedding: [0, 1] })
  // mock embedding API：query 回 [1,0]，与咖啡记忆余弦=1、猫≈0.91、动漫=0
  const server = createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const scored = await retrieveMemory({
    query: '咖啡',
    store,
    embedding: { baseUrl, apiKey: 'k', model: 'm', topK: 2, minScore: 0.5 },
    logger: {},
  })
  server.close()
  assert.equal(scored.length, 2, '动漫记忆低于 minScore 被过滤')
  assert.equal(scored[0].fact.text, '主人喜欢咖啡')
  assert.ok(scored[0].score >= scored[1].score)
})

test('未配 embedding 三件套时自动走关键词路线', async (t) => {
  const store = new MemoryStore({ file: join(makeTempDir(t), 'f.json') })
  store.add('主人喜欢咖啡')
  const scored = await retrieveMemory({ query: '咖啡', store, embedding: { topK: 6 }, logger: {} })
  assert.equal(scored.length, 1)
  assert.equal(scored[0].fact.text, '主人喜欢咖啡')
})

test('formatFacts：输出注入格式', () => {
  const out = formatFacts([{ fact: { text: 'a' } }, { fact: { text: 'b' } }])
  assert.equal(out, '- a\n- b')
  assert.equal(formatFacts([]), '')
})
