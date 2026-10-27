/**
 * test/onebot.test.mjs —— OneBot 11 客户端测试
 * 用本地 ws 服务器模拟 NapCat，覆盖：
 *   状态机全链路、事件归一化、API 成功/失败/超时、断线重连与退避、
 *   dispose 终态、脏数据、token 拼接、在途调用断线失败（测试原则 3/4/5/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket } from 'ws'
import { OneBotClient, OneBotError } from '../lib/onebot/client.mjs'
import { normalizeEvent, extractText, buildMessage } from '../lib/onebot/events.mjs'

/** 起一个空 mock 服务器，返回 wss（测试结束自动收摊）。 */
async function startMock(t) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.on('listening', r))
  const url = `ws://127.0.0.1:${wss.address().port}`
  t.after(() => {
    for (const c of wss.clients) { try { c.terminate() } catch { /* 已断 */ } }
    wss.close()
  })
  return { wss, url }
}

async function waitFor(fn, ms = 3000, label = 'waitFor') {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`${label} 超时`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

test('连接成功：状态机 disconnected → connecting → connected，收生命周期事件不报错', async (t) => {
  const { wss, url } = await startMock(t)
  let connections = 0
  wss.on('connection', (ws) => {
    connections++
    ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable', self_id: 111 }))
  })
  const client = new OneBotClient({ url, logger: quietLog })
  client.start()
  await waitFor(() => client.state === 'connected')
  assert.equal(connections, 1)
  assert.deepEqual(client.stateHistory.slice(0, 3), ['connecting', 'connected'])
  client.dispose()
})

test('事件归一化：私聊/群聊/notice/未知包', async (t) => {
  const { wss, url } = await startMock(t)
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 1, user_id: 100, time: 1, raw_message: 'hi', message: [{ type: 'text', data: { text: 'hi' } }], sender: { nickname: '主人' } }))
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', message_id: 2, user_id: 100, time: 1, group_id: 999, message: [{ type: 'text', data: { text: '哈' } }, { type: 'face', data: { id: '178' } }], sender: { card: '群主' } }))
    ws.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_increase', group_id: 999, user_id: 7 }))
    ws.send(JSON.stringify({ post_type: 'weird_thing' }))
  })
  const got = []
  const client = new OneBotClient({ url, logger: quietLog })
  client.onEvent((e) => { got.push(normalizeEvent(e)) })
  client.start()
  await waitFor(() => got.length >= 4)
  const priv = got[0]
  assert.equal(priv.type, 'message')
  assert.equal(priv.subType, 'private')
  assert.equal(priv.userId, 100)
  assert.equal(priv.text, 'hi')
  assert.equal(priv.senderName, '主人')
  const group = got[1]
  assert.equal(group.subType, 'group')
  assert.equal(group.groupId, 999)
  assert.equal(group.text, '哈')
  assert.equal(group.senderName, '群主')
  assert.deepEqual(group.segments[1], { type: 'face', data: { id: '178' } })
  assert.equal(got[2].type, 'notice')
  assert.equal(got[2].noticeType, 'group_increase')
  assert.equal(got[3].type, 'unknown')
  client.dispose()
})

test('API 调用：成功返回 data，失败按 retcode 报错', async (t) => {
  const { wss, url } = await startMock(t)
  wss.on('connection', (ws) => {
    ws.on('message', (buf) => {
      const req = JSON.parse(buf.toString())
      if (req.action === 'send_private_msg') {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: req.echo }))
      } else if (req.action === 'get_stranger_info') {
        ws.send(JSON.stringify({ status: 'failed', retcode: 1403, message: '对方不是好友', echo: req.echo }))
      }
    })
  })
  const client = new OneBotClient({ url, logger: quietLog })
  client.start()
  await waitFor(() => client.state === 'connected')
  const ok = await client.callApi('send_private_msg', { user_id: 100, message: 'hi' })
  assert.deepEqual(ok, { message_id: 42 })
  await assert.rejects(
    client.callApi('get_stranger_info', { user_id: 1 }),
    (e) => e instanceof OneBotError && e.code === 'EBOT-API-1403' && /对方不是好友/.test(e.message),
  )
  client.dispose()
})

test('API 超时：服务器不回包 → EBOT-API-TIMEOUT', async (t) => {
  const { wss, url } = await startMock(t)
  wss.on('connection', () => { /* 收下不回 */ })
  const client = new OneBotClient({ url, apiTimeoutMs: 80, logger: quietLog })
  client.start()
  await waitFor(() => client.state === 'connected')
  await assert.rejects(client.callApi('send_private_msg', {}), (e) => e.code === 'EBOT-API-TIMEOUT')
  client.dispose()
})

test('未连接时调用 API 立即失败（EBOT-NOT-CONNECTED）', async (t) => {
  const { wss, url } = await startMock(t)
  const client = new OneBotClient({ url, logger: quietLog })
  await assert.rejects(client.callApi('send_private_msg', {}), (e) => e.code === 'EBOT-NOT-CONNECTED')
  client.dispose()
})

test('断线重连：服务器断开后自动重连成功，退避间隔非降', async (t) => {
  const { wss, url } = await startMock(t)
  const connectTimes = []
  wss.on('connection', (ws) => {
    connectTimes.push(Date.now())
    setTimeout(() => { try { ws.close() } catch { /* 已断 */ } }, 60)
  })
  const client = new OneBotClient({ url, reconnectBaseMs: 60, reconnectMaxMs: 500, jitterRatio: 0, logger: quietLog })
  client.start()
  await waitFor(() => connectTimes.length >= 3, 5000, '三次连接')
  await waitFor(() => client.state === 'reconnecting')
  assert.ok(client.stateHistory.includes('reconnecting'), '状态机应经过 reconnecting')
  const d1 = connectTimes[1] - connectTimes[0]
  const d2 = connectTimes[2] - connectTimes[1]
  assert.ok(d1 >= 60, `第一次退避应 >=60ms（实际 ${d1}）`)
  assert.ok(d2 >= d1, `退避间隔应非降（d1=${d1}, d2=${d2}）`)
  client.dispose()
})

test('在途 API 调用在断线时立即失败（EBOT-NOT-CONNECTED）', async (t) => {
  const { wss, url } = await startMock(t)
  let first = null
  wss.on('connection', (ws) => {
    first = ws
    // 收到 send_private_msg 后立刻掐断（不回包）
    ws.on('message', () => { try { ws.close() } catch { /* 已断 */ } })
  })
  const client = new OneBotClient({ url, apiTimeoutMs: 5000, logger: quietLog })
  client.start()
  await waitFor(() => client.state === 'connected')
  const p = client.callApi('send_private_msg', {})
  await assert.rejects(p, (e) => e.code === 'EBOT-NOT-CONNECTED')
  client.dispose()
})

test('dispose 是终态：断开后不再重连，在途调用被失败', async (t) => {
  const { wss, url } = await startMock(t)
  let connections = 0
  wss.on('connection', () => { connections++ })
  const client = new OneBotClient({ url, reconnectBaseMs: 30, logger: quietLog })
  client.start()
  await waitFor(() => client.state === 'connected')
  client.dispose()
  assert.equal(client.state, 'disposed')
  await assert.rejects(client.callApi('send_private_msg', {}), (e) => e.code === 'EBOT-DISPOSED')
  const after = connections
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(connections, after, 'dispose 后不应再有新连接')
})

test('脏数据：非 JSON 包被忽略，连接不崩，后续正常包照常处理', async (t) => {
  const { wss, url } = await startMock(t)
  wss.on('connection', (ws) => {
    ws.send('{{{不是JSON')
    setTimeout(() => ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 9, user_id: 1, message: [{ type: 'text', data: { text: '还在吗' } }] })), 30)
  })
  const got = []
  const client = new OneBotClient({ url, logger: quietLog })
  client.onEvent((e) => got.push(normalizeEvent(e)))
  client.start()
  await waitFor(() => got.length >= 1)
  assert.equal(got[0].text, '还在吗')
  client.dispose()
})

test('事件处理器抛错不影响其他处理器和连接', async (t) => {
  const { wss, url } = await startMock(t)
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 5, user_id: 1, message: [{ type: 'text', data: { text: 'x' } }] }))
  })
  const got = []
  const client = new OneBotClient({ url, logger: quietLog })
  client.onEvent(() => { throw new Error('第一个处理器炸了') })
  client.onEvent((e) => got.push(normalizeEvent(e)))
  client.start()
  await waitFor(() => got.length >= 1)
  assert.equal(got[0].text, 'x')
  client.dispose()
})

test('token 通过 URL query 传给 NapCat', async (t) => {
  const { wss, url } = await startMock(t)
  const seen = []
  wss.on('connection', (_ws, req) => { seen.push(req.url) })
  const client = new OneBotClient({ url, token: 'tk-123', logger: quietLog })
  client.start()
  await waitFor(() => seen.length >= 1)
  assert.match(seen[0], /access_token=tk-123/)
  client.dispose()
})

test('extractText / buildMessage 契约', () => {
  assert.equal(extractText([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: {} }, { type: 'text', data: { text: 'b' } }]), 'ab')
  assert.equal(extractText([]), '')
  assert.equal(buildMessage('纯文本'), '纯文本')
  const arr = [{ type: 'text', data: { text: 't' } }]
  assert.equal(buildMessage(arr), arr, '数组原样返回')
  assert.deepEqual(buildMessage({ text: 'hi', image: 'base64://x', atUser: 123, face: 178 }), [
    { type: 'at', data: { qq: '123' } },
    { type: 'image', data: { file: 'base64://x' } },
    { type: 'face', data: { id: '178' } },
    { type: 'text', data: { text: 'hi' } },
  ])
  assert.throws(() => buildMessage(42), (e) => e.code === 'EBOT-BAD-MESSAGE')
})
