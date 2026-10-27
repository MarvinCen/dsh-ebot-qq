/**
 * test/llm.test.mjs —— OpenAI 兼容 LLM 客户端测试
 * 用本地 http server mock 模型服务，覆盖成功/reasoning/4xx 不重试/5xx 重试/
 * 超时/网络失败/空响应/取消（测试原则 5/8：异步边界与失败路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { LlmClient, LlmError } from '../lib/chat/llm.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 起一个可编程的 mock 模型服务。handler(req, body, count) 可返回 {status, body, delayMs}。 */
async function startHttp(t, handler) {
  let count = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    count++
    const out = await handler(JSON.parse(body || '{}'), count)
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs))
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out.body ?? {}))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(() => server.close())
  return { url, calls: () => count }
}

const okBody = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 10 } })

function client(url, opts = {}) {
  return new LlmClient({ baseUrl: url, apiKey: 'sk-t', model: 'm', timeoutMs: 2000, ...opts })
}

test('成功：返回 content 文本与 usage', async (t) => {
  const { url } = await startHttp(t, () => ({ body: okBody('你好呀') }))
  const { text, usage } = await client(url).chatComplete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(text, '你好呀')
  assert.equal(usage.total_tokens, 10)
})

test('reasoning 模型：content 为空时退回 reasoning_content', async (t) => {
  const { url } = await startHttp(t, () => ({
    body: { choices: [{ message: { content: '', reasoning_content: '想完之后的回答' } }] },
  }))
  const { text } = await client(url).chatComplete({ messages: [] })
  assert.equal(text, '想完之后的回答')
})

test('4xx：不重试，透出服务端错误文案', async (t) => {
  const { url, calls } = await startHttp(t, () => ({ status: 401, body: { error: { message: 'key 无效' } } }))
  await assert.rejects(client(url).chatComplete({ messages: [] }), (e) => e.code === 'EBOT-LLM-HTTP-401' && /key 无效/.test(e.message))
  assert.equal(calls(), 1, '4xx 不应重试')
})

test('5xx：重试两次后仍失败，报 EBOT-LLM-HTTP-5XX', async (t) => {
  const { url, calls } = await startHttp(t, () => ({ status: 503, body: {} }))
  await assert.rejects(client(url, { retries: 2 }).chatComplete({ messages: [] }), (e) => e.code === 'EBOT-LLM-HTTP-5XX')
  assert.equal(calls(), 3, '共 3 次尝试')
})

test('超时：报 EBOT-LLM-TIMEOUT', async (t) => {
  const { url } = await startHttp(t, () => ({ delayMs: 500, body: okBody('x') }))
  await assert.rejects(client(url, { timeoutMs: 50, retries: 0 }).chatComplete({ messages: [] }), (e) => e.code === 'EBOT-LLM-TIMEOUT')
})

test('网络失败：连不上的地址报 EBOT-LLM-NETWORK', async () => {
  // 起一个立刻关闭的 server 拿到一个必然拒绝连接的端口
  const dead = createServer()
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const port = dead.address().port
  await new Promise((r) => dead.close(r))
  await assert.rejects(client(`http://127.0.0.1:${port}`, { retries: 0 }).chatComplete({ messages: [] }), (e) => e.code === 'EBOT-LLM-NETWORK')
})

test('空响应：content 与 reasoning 都为空报 EBOT-LLM-EMPTY', async (t) => {
  const { url } = await startHttp(t, () => ({ body: { choices: [{ message: { content: '' } }] } }))
  await assert.rejects(client(url, { retries: 0 }).chatComplete({ messages: [] }), (e) => e.code === 'EBOT-LLM-EMPTY')
})

test('取消：abort signal 报 EBOT-LLM-CANCELLED', async (t) => {
  const { url } = await startHttp(t, () => ({ delayMs: 300, body: okBody('x') }))
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 30)
  await assert.rejects(client(url, { retries: 0 }).chatComplete({ messages: [], signal: ctrl.signal }), (e) => e.code === 'EBOT-LLM-CANCELLED')
})

test('baseUrl 尾部斜杠被归一化（拼接 /chat/completions 不重复）', async (t) => {
  let seenPath = ''
  const server = createServer((req, res) => { seenPath = req.url; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(okBody('x'))) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/v1/`
  await client(base, { retries: 0 }).chatComplete({ messages: [] })
  assert.equal(seenPath, '/v1/chat/completions')
  server.close()
})
