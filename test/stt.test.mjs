/**
 * test/stt.test.mjs —— 收语音（record 解析 + 转写）测试
 * 覆盖：base64 / URL 下载（成功、404、超时）/ 本地文件 / 空来源、
 *       转写服务成功、空结果、服务不可用（测试原则 5/6/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { resolveRecordBytes, sttTranscribe, VoiceError } from '../lib/voice/stt.mjs'
import { makeTempDir } from './helpers.mjs'

test('base64:// 来源解析', async () => {
  const bytes = await resolveRecordBytes('base64://' + Buffer.from('hello-audio').toString('base64'))
  assert.equal(Buffer.from(bytes).toString(), 'hello-audio')
})

test('base64 为空时报 EBOT-STT-BAD-RECORD', async () => {
  await assert.rejects(resolveRecordBytes('base64://'), (e) => e.code === 'EBOT-STT-BAD-RECORD')
})

test('http 来源下载成功', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200); res.end(Buffer.from('remote-audio')) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const bytes = await resolveRecordBytes(`http://127.0.0.1:${server.address().port}/voice.amr`)
  assert.equal(Buffer.from(bytes).toString(), 'remote-audio')
  server.close()
})

test('http 404 报 EBOT-STT-HTTP-404', async (t) => {
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  await assert.rejects(resolveRecordBytes(`http://127.0.0.1:${server.address().port}/x`), (e) => e.code === 'EBOT-STT-HTTP-404')
  server.close()
})

test('http 超时报 EBOT-STT-TIMEOUT', async (t) => {
  const server = createServer(async (req, res) => { await new Promise((r) => setTimeout(r, 300)); res.end('x') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  await assert.rejects(
    resolveRecordBytes(`http://127.0.0.1:${server.address().port}/x`, { timeoutMs: 50 }),
    (e) => e.code === 'EBOT-STT-TIMEOUT',
  )
  server.close()
})

test('本地文件来源（含 file:// 前缀与裸路径）', async (t) => {
  const dir = makeTempDir(t)
  const file = join(dir, 'a.amr')
  writeFileSync(file, 'local-audio')
  assert.equal(Buffer.from(await resolveRecordBytes(file)).toString(), 'local-audio')
  assert.equal(Buffer.from(await resolveRecordBytes('file://' + file)).toString(), 'local-audio')
})

test('空 file 报 EBOT-STT-BAD-RECORD', async () => {
  await assert.rejects(resolveRecordBytes(''), (e) => e.code === 'EBOT-STT-BAD-RECORD')
})

const fakeSttCtx = (impl) => ({
  get: (name) => (name === 'speechToText' ? impl : undefined),
})

test('转写成功：resolve({audio}) → transcribe(spec) → 文本', async () => {
  let resolvedAudio = null
  const ctx = fakeSttCtx({
    resolve: (req) => { resolvedAudio = req.audio; return { audio: req.audio, provider: {} } },
    transcribe: async (spec) => ({ text: ' 今晚吃什么 ', audioSeconds: 2, inferenceSeconds: 1 }),
  })
  const { text } = await sttTranscribe(ctx, new Uint8Array([1, 2, 3]))
  assert.equal(text, '今晚吃什么')
  assert.deepEqual(resolvedAudio, new Uint8Array([1, 2, 3]))
})

test('转写结果为空报 EBOT-STT-EMPTY', async () => {
  const ctx = fakeSttCtx({
    resolve: (req) => ({ audio: req.audio }),
    transcribe: async () => ({ text: '   ', audioSeconds: 1, inferenceSeconds: 0 }),
  })
  await assert.rejects(sttTranscribe(ctx, new Uint8Array([1])), (e) => e.code === 'EBOT-STT-EMPTY')
})

test('speechToText 服务不可用报 EBOT-STT-UNAVAILABLE', async () => {
  await assert.rejects(sttTranscribe({ get: () => undefined }, new Uint8Array([1])), (e) => e.code === 'EBOT-STT-UNAVAILABLE')
  await assert.rejects(sttTranscribe(null, new Uint8Array([1])), (e) => e.code === 'EBOT-STT-UNAVAILABLE')
})

test('transcribe 抛错原样上抛（不吞）', async () => {
  const boom = new Error('识别炸了')
  const ctx = fakeSttCtx({
    resolve: (req) => ({ audio: req.audio }),
    transcribe: async () => { throw boom },
  })
  await assert.rejects(sttTranscribe(ctx, new Uint8Array([1])), (e) => e === boom)
})

test('VoiceError 是带 code 的 Error 子类', () => {
  const e = new VoiceError('EBOT-X', 'msg')
  assert.ok(e instanceof Error)
  assert.equal(e.code, 'EBOT-X')
})
