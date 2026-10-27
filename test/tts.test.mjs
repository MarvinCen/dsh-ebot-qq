/**
 * test/tts.test.mjs —— 发语音（TTS 双引擎）测试
 * 覆盖：文本截断、off 路由、Piper（成功/无模型/启动失败/合成失败）、
 *       OpenAI 兼容（成功/400/超时/空响应）（测试原则 5/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { writeFileSync, chmodSync } from 'node:fs'
import { truncateForTts, synthText, ttsPiper, ttsOpenai } from '../lib/voice/tts.mjs'
import { makeTempDir } from './helpers.mjs'

test('truncateForTts：短文本原样，长文本按句号边界截断', () => {
  assert.equal(truncateForTts('早上好'), '早上好')
  const long = '第一句。'.repeat(100)
  const cut = truncateForTts(long)
  assert.ok(cut.length <= 150)
  assert.ok(cut.endsWith('。'), '尽量在句号处截断')
  const noPunct = 'x'.repeat(300)
  assert.equal(truncateForTts(noPunct).length, 150, '没有句号就硬截')
  assert.equal(truncateForTts('   '), '')
})

test('synthText：provider off 报 EBOT-TTS-PROVIDER-OFF，空文本报 EBOT-TTS-EMPTY', async () => {
  await assert.rejects(synthText({ provider: 'off', text: '你好' }), (e) => e.code === 'EBOT-TTS-PROVIDER-OFF')
  await assert.rejects(synthText({ provider: 'piper', text: '   ' }), (e) => e.code === 'EBOT-TTS-EMPTY')
})

test('Piper：模型未配置报 EBOT-TTS-PIPER-NO-MODEL', async () => {
  await assert.rejects(ttsPiper({ bin: 'piper', model: '', text: 'x', tmpFile: '/tmp/x.wav' }), (e) => e.code === 'EBOT-TTS-PIPER-NO-MODEL')
})

test('Piper：用假可执行文件合成成功（stdin 进文本，output_file 出 wav）', async (t) => {
  const dir = makeTempDir(t)
  const bin = join(dir, 'fake-piper.sh')
  writeFileSync(bin, '#!/bin/sh\nOUT=""\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--output_file" ]; then shift; OUT="$1"; fi\n  shift\ndone\nprintf FAKEWAV > "$OUT"\n', 'utf8')
  chmodSync(bin, 0o755)
  const out = join(dir, 'out.wav')
  const { data, format } = await ttsPiper({ bin, model: 'zh.onnx', text: '你好', tmpFile: out })
  assert.equal(format, 'wav')
  assert.equal(Buffer.from(data).toString(), 'FAKEWAV')
})

test('Piper：可执行文件不存在报 EBOT-TTS-PIPER-SPAWN', async (t) => {
  const dir = makeTempDir(t)
  await assert.rejects(
    ttsPiper({ bin: join(dir, 'no-such-piper'), model: 'm.onnx', text: 'x', tmpFile: join(dir, 'o.wav') }),
    (e) => e.code === 'EBOT-TTS-PIPER-SPAWN',
  )
})

test('Piper：进程非零退出报 EBOT-TTS-PIPER-FAILED', async (t) => {
  const dir = makeTempDir(t)
  const bin = join(dir, 'fail-piper.sh')
  writeFileSync(bin, '#!/bin/sh\necho 模型坏了 >&2\nexit 1\n', 'utf8')
  chmodSync(bin, 0o755)
  await assert.rejects(
    ttsPiper({ bin, model: 'm.onnx', text: 'x', tmpFile: join(dir, 'o.wav') }),
    (e) => e.code === 'EBOT-TTS-PIPER-FAILED' && /模型坏了/.test(e.message),
  )
})

test('Piper：没产出文件报 EBOT-TTS-PIPER-OUTPUT', async (t) => {
  const dir = makeTempDir(t)
  const bin = join(dir, 'empty-piper.sh')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(bin, 0o755)
  await assert.rejects(
    ttsPiper({ bin, model: 'm.onnx', text: 'x', tmpFile: join(dir, 'never.wav') }),
    (e) => e.code === 'EBOT-TTS-PIPER-OUTPUT',
  )
})

test('OpenAI 兼容：合成成功返回字节与格式', async (t) => {
  let seenBody = null
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/audio/speech')
    let body = ''
    for await (const c of req) body += c
    seenBody = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(Buffer.from('MP3DATA'))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const { data, format } = await ttsOpenai({ baseUrl, apiKey: 'k', model: 'tts-1', voice: 'shimmer', format: 'mp3', text: '你好' })
  assert.equal(format, 'mp3')
  assert.equal(Buffer.from(data).toString(), 'MP3DATA')
  assert.deepEqual(seenBody, { model: 'tts-1', voice: 'shimmer', input: '你好', response_format: 'mp3' })
  server.close()
})

test('OpenAI 兼容：baseUrl 未配置报 EBOT-TTS-OPENAI-NO-URL', async () => {
  await assert.rejects(ttsOpenai({ baseUrl: '', apiKey: 'k', text: 'x' }), (e) => e.code === 'EBOT-TTS-OPENAI-NO-URL')
})

test('OpenAI 兼容：400 报 EBOT-TTS-HTTP-400', async (t) => {
  const server = createServer((req, res) => { res.writeHead(400); res.end('{}') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(ttsOpenai({ baseUrl, apiKey: 'k', text: 'x' }), (e) => e.code === 'EBOT-TTS-HTTP-400')
  server.close()
})

test('OpenAI 兼容：空响应报 EBOT-TTS-EMPTY', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200); res.end('') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(ttsOpenai({ baseUrl, apiKey: 'k', text: 'x' }), (e) => e.code === 'EBOT-TTS-EMPTY')
  server.close()
})

test('OpenAI 兼容：网络失败报 EBOT-TTS-NETWORK', async () => {
  await assert.rejects(ttsOpenai({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', text: 'x', timeoutMs: 3000 }), (e) => e.code === 'EBOT-TTS-NETWORK')
})
