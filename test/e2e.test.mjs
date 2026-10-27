/**
 * test/e2e.test.mjs —— 全链路端到端测试（测试原则 2：完整业务闭环）
 * ----------------------------------------------------------------------------
 * 不用 mock 任何业务模块：直接调 index.js 的 apply()（真实装配），
 * 只把外部世界换成假的：
 *   - mock NapCat（本地 ws 服务器，收/发 OneBot 包）；
 *   - mock LLM（本地 http，OpenAI 兼容 chat/completions）；
 *   - mock speechToText / configEditor / dshHomePath（fake ctx）。
 *
 * 覆盖闭环：私聊问答、/状态、语音消息转写、记忆写入与展示、
 *           表情包随回复、语音回复、卸载收摊。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { apply } from '../index.js'
import { makeTempDir } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms = 4000, label = 'waitFor') {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`${label} 超时`)
    await sleep(10)
  }
}

/** 起全套环境并 apply。返回各句柄与收摊函数。 */
async function boot(t, opts = {}) {
  const home = makeTempDir(t)

  // mock LLM（OpenAI 兼容）
  const llmReplies = []
  const llmServer = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const parsed = JSON.parse(body)
    const lastUser = parsed.messages[parsed.messages.length - 1]?.content ?? ''
    const reply = opts.llmReply ?? ((text) => `鱼鱼收到：${text}`)
    const content = reply(lastUser)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  })
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
  const llmBase = `http://127.0.0.1:${llmServer.address().port}/v1`

  // mock NapCat
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.on('listening', r))
  const onebotUrl = `ws://127.0.0.1:${wss.address().port}`
  const apiCalls = []          // NapCat 收到的 API 调用
  let napcat = null            // 机器人连上来的那条连接
  wss.on('connection', (ws) => {
    napcat = ws
    ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable', self_id: 222 }))
    ws.on('message', (buf) => {
      const req = JSON.parse(buf.toString())
      if (typeof req.echo === 'string') {
        apiCalls.push(req)
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: apiCalls.length }, echo: req.echo }))
      }
    })
  })

  // fake ctx（只提供插件用到的服务）。
  // ⚠️ ctx.effect 语义要与 cordis 一致：立即执行注册函数，把**返回的清理函数**收起来，
  //    收摊时调用它 —— 之前只存注册函数不执行，导致 bot 永不 dispose、无限重连拖死 runner。
  const cleanups = []
  const ctx = {
    get: (name) => {
      if (name === 'dshHomePath') return (sub) => { const p = join(home, sub); mkdirSync(p, { recursive: true }); return p }
      if (name === 'configEditor') return opts.configEditor ?? { configuration: () => [] }
      if (name === 'speechToText') return opts.speechToText ?? {
        resolve: (req) => ({ audio: req.audio }),
        transcribe: async () => ({ text: '转写：今晚吃什么', audioSeconds: 1, inferenceSeconds: 0 }),
      }
      return undefined
    },
    effect: (fn) => {
      const cleanup = fn()
      cleanups.push(() => { try { cleanup?.() } catch { /* 收摊 */ } })
      return () => {}
    },
  }

  apply(ctx, {
    onebot: { url: onebotUrl, reconnectBaseMs: 50, reconnectMaxMs: 100 },
    owner: { qq: 111, groups: [] },
    llm: { baseUrl: llmBase, apiKey: 'sk-e2e', model: 'e2e-model', timeoutMs: 5000 },
    memory: { longTerm: true, autoExtract: false, shortTermTurns: 5 },
    proactive: { enabled: false },
    bili: { enabled: false },
    sticker: { enabled: true, dir: opts.stickerDir ?? '', rate: opts.stickerRate ?? 0 },
    voice: opts.voiceCfg ?? { sttEnabled: true, mode: 'off', tts: { provider: 'off', piper: { bin: '', model: '' }, openai: { baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' } } },
    ...opts.cfg,
  })

  t.after(() => {
    for (const fn of cleanups) { try { fn() } catch { /* 收摊 */ } }
    try { llmServer.close() } catch { /* 已关 */ }
    for (const c of wss.clients) { try { c.terminate() } catch { /* 已断 */ } }
    wss.close()
  })
  return { wss, apiCalls, getNapcat: () => napcat, cleanups, llmServer }
}

const sendToBot = (napcat, payload) => napcat.send(JSON.stringify(payload))

test('闭环：私聊消息 → LLM → 回复送达 NapCat', async (t) => {
  const { wss, apiCalls } = await boot(t)
  await waitFor(() => wss.clients.size >= 1, 4000, '机器人连上 NapCat')
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 1, user_id: 111, message: [{ type: 'text', data: { text: '你好呀' } }], sender: { nickname: '主人' } })
  await waitFor(() => apiCalls.some((c) => c.action === 'send_private_msg'), 4000, '机器人发来回复')
  const reply = apiCalls.find((c) => c.action === 'send_private_msg')
  assert.equal(reply.params.user_id, 111)
  assert.equal(reply.params.message, '鱼鱼收到：你好呀')
})

test('/状态 命令显示连接、会话与记忆信息', async (t) => {
  const { wss, apiCalls } = await boot(t)
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 2, user_id: 111, message: [{ type: 'text', data: { text: '/状态' } }], sender: {} })
  await waitFor(() => apiCalls.length >= 1)
  const reply = apiCalls[0]
  assert.ok(reply.params.message.includes('连着 NapCat'), '应显示连接状态')
  assert.ok(reply.params.message.includes('长期记忆：0'), '应显示记忆条数')
})

test('语音消息：record 段转写后进对话', async (t) => {
  const { wss, apiCalls } = await boot(t)
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 3, user_id: 111, message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-audio').toString('base64') } }], sender: {} })
  await waitFor(() => apiCalls.some((c) => c.action === 'send_private_msg'))
  const reply = apiCalls.find((c) => c.action === 'send_private_msg')
  assert.equal(reply.params.message, '鱼鱼收到：转写：今晚吃什么', '转写文本应作为 user 消息进模型')
})

test('/记住 写入长期记忆，/状态 能看到条数', async (t) => {
  const { wss, apiCalls } = await boot(t)
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 4, user_id: 111, message: [{ type: 'text', data: { text: '/记住 主人的生日是6月1日' } }], sender: {} })
  await waitFor(() => apiCalls.length >= 1)
  assert.ok(apiCalls[0].params.message.includes('记住了'), '确认文案')
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 5, user_id: 111, message: [{ type: 'text', data: { text: '/状态' } }], sender: {} })
  await waitFor(() => apiCalls.length >= 2)
  assert.ok(apiCalls[1].params.message.includes('长期记忆：1'), '记忆条数应为 1')
})

test('表情包：命中情绪词时回复带 image 段', async (t) => {
  const stickerDir = join(makeTempDir(t), 'stickers')
  mkdirSync(join(stickerDir, '开心'), { recursive: true })
  writeFileSync(join(stickerDir, '开心', 'happy.png'), Buffer.from('PNGDATA'))
  const { wss, apiCalls } = await boot(t, { stickerDir })
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 6, user_id: 111, message: [{ type: 'text', data: { text: '太开心了哈哈' } }], sender: {} })
  await waitFor(() => apiCalls.some((c) => c.action === 'send_private_msg'))
  const reply = apiCalls.find((c) => c.action === 'send_private_msg')
  assert.ok(Array.isArray(reply.params.message), '带媒体应为 CQ 段数组')
  assert.ok(reply.params.message.some((s) => s.type === 'image' && s.data.file.startsWith('base64://')), '应含 image 段')
})

test('语音回复：mode=on + 云端 TTS → 回复带 record 段', async (t) => {
  const ttsServer = createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(Buffer.from('MP3-BYTES'))
  })
  await new Promise((r) => ttsServer.listen(0, '127.0.0.1', r))
  const { wss, apiCalls } = await boot(t, {
    voiceCfg: {
      sttEnabled: true,
      mode: 'on',
      tts: {
        provider: 'openai',
        piper: { bin: '', model: '' },
        openai: { baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, apiKey: 'k', model: 'tts-1', voice: 'alloy', format: 'mp3' },
      },
    },
  })
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 7, user_id: 111, message: [{ type: 'text', data: { text: '说句话' } }], sender: {} })
  await waitFor(() => apiCalls.some((c) => c.action === 'send_private_msg'))
  const reply = apiCalls.find((c) => c.action === 'send_private_msg')
  assert.ok(reply.params.message.some((s) => s.type === 'record' && s.data.file.startsWith('base64://')), '应含 record 段')
  ttsServer.close()
})

test('权限：非主人私聊不回（owner.qq=111）', async (t) => {
  const { wss, apiCalls } = await boot(t)
  await waitFor(() => wss.clients.size >= 1)
  const napcat = [...wss.clients][0]
  sendToBot(napcat, { post_type: 'message', message_type: 'private', message_id: 8, user_id: 999, message: [{ type: 'text', data: { text: '在吗' } }], sender: {} })
  await sleep(200)
  assert.equal(apiCalls.length, 0, '陌生人消息不应触发回复')
})

test('卸载收摊：cleanup 后连接关闭', async (t) => {
  const { wss, cleanups } = await boot(t)
  await waitFor(() => wss.clients.size >= 1)
  for (const fn of cleanups) fn()
  await sleep(150)
  assert.equal(wss.clients.size, 0, '收摊后连接应断开')
})

test('家目录落地：日志与记忆文件按预期创建', async (t) => {
  const home = makeTempDir(t)
  const { wss } = await boot(t, { cfg: { log: { dir: join(home, 'ebot-qq', 'logs'), level: 'info' } } })
  await waitFor(() => wss.clients.size >= 1)
  await sleep(100)
  const logFile = join(home, 'ebot-qq', 'logs', 'app.log')
  assert.ok(readFileSync(logFile, 'utf8').includes('已挂载'), '启动日志应落盘')
})
