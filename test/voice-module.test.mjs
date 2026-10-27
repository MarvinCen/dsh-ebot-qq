/**
 * test/voice-module.test.mjs —— 语音模块装配测试（hooks + 命令，chat 视角）
 * 覆盖：stt hook 开关/取 record 段/转写链路、voice hook 三种 mode、
 *       /语音 命令（参数校验、成功、失败软文案、未启用提示）（测试原则 1/2/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createVoiceModule } from '../lib/voice/index.mjs'
import { makeTempDir } from './helpers.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

function baseCfg(over = {}) {
  return {
    voice: {
      sttEnabled: true,
      mode: 'off',
      tts: {
        provider: 'off',
        piper: { bin: '', model: '' },
        openai: { baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
      },
    },
    ...over,
  }
}

const recordEvent = (file) => ({
  type: 'message', subType: 'private', userId: 1,
  segments: [{ type: 'record', data: { file } }],
})

test('stt hook：sttEnabled=false 直接返回 null', async (t) => {
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg({ voice: { ...baseCfg().voice, sttEnabled: false } }), logger: quietLog, stateDir: makeTempDir(t) })
  assert.equal(await m.hooks.stt(recordEvent('base64://x')), null)
})

test('stt hook：无 record 段返回 null', async (t) => {
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg(), logger: quietLog, stateDir: makeTempDir(t) })
  assert.equal(await m.hooks.stt({ type: 'message', subType: 'private', segments: [{ type: 'text', data: { text: 'x' } }] }), null)
})

test('stt hook：转写链路贯通（base64 record → speechToText → 文本）', async (t) => {
  const ctx = {
    get: (name) => name === 'speechToText' ? {
      resolve: (req) => ({ audio: req.audio }),
      transcribe: async () => ({ text: '转出来的话', audioSeconds: 1, inferenceSeconds: 0 }),
    } : undefined,
  }
  const m = createVoiceModule({ ctx, cfg: baseCfg(), logger: quietLog, stateDir: makeTempDir(t) })
  const text = await m.hooks.stt(recordEvent('base64://' + Buffer.from('audio').toString('base64')))
  assert.equal(text, '转出来的话')
})

test('voice hook：mode=off 返回 undefined；smart 对长文本返回 undefined', async (t) => {
  const stateDir = makeTempDir(t)
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg(), logger: quietLog, stateDir })
  assert.equal(await m.hooks.voice('你好'), undefined)
  const smart = createVoiceModule({ ctx: {}, cfg: baseCfg({ voice: { ...baseCfg().voice, mode: 'smart', tts: { ...baseCfg().voice.tts, provider: 'openai', openai: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', voice: 'v', format: 'mp3' } } } }), logger: quietLog, stateDir })
  assert.equal(await smart.hooks.voice('长'.repeat(200)), undefined, 'smart 模式长回复不配音')
})

test('voice hook：mode=on 且 openai 引擎 → 返回 base64 record', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.from('MP3DATA')) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const openai = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'tts-1', voice: 'alloy', format: 'mp3' }
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg({ voice: { ...baseCfg().voice, mode: 'on', tts: { ...baseCfg().voice.tts, provider: 'openai', openai } } }), logger: quietLog, stateDir: makeTempDir(t) })
  const record = await m.hooks.voice('早上好')
  server.close()
  assert.ok(record.startsWith('base64://'))
  assert.equal(Buffer.from(record.slice('base64://'.length), 'base64').toString(), 'MP3DATA')
})

test('voice hook：合成失败向上抛（由 chat 装饰层兜底记日志）', async (t) => {
  const m = createVoiceModule({
    ctx: {},
    cfg: baseCfg({ voice: { ...baseCfg().voice, mode: 'on', tts: { ...baseCfg().voice.tts, provider: 'openai', openai: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', voice: 'v', format: 'mp3' } } } }),
    logger: quietLog,
    stateDir: makeTempDir(t),
  })
  await assert.rejects(m.hooks.voice('你好'), (e) => e.code === 'EBOT-TTS-NETWORK')
})

test('/语音 命令：空参数给提示；TTS 未启用给引导', async (t) => {
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg(), logger: quietLog, stateDir: makeTempDir(t) })
  assert.match(await m.commands['语音']({}, 'p', []), /后面加上想让我说的话/)
  assert.match(await m.commands['语音']({}, 'p', ['你好']), /语音功能没开/)
})

test('/语音 命令：成功返回 record 段形态的回复', async (t) => {
  const server = createServer((req, res) => { res.writeHead(200); res.end(Buffer.from('CMD-MP3')) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const openai = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'tts-1', voice: 'alloy', format: 'mp3' }
  const m = createVoiceModule({ ctx: {}, cfg: baseCfg({ voice: { ...baseCfg().voice, tts: { ...baseCfg().voice.tts, provider: 'openai', openai } } }), logger: quietLog, stateDir: makeTempDir(t) })
  const reply = await m.commands['语音']({}, 'p', ['主人', '早上好'])
  server.close()
  assert.ok(reply.record.startsWith('base64://'))
  assert.equal(Buffer.from(reply.record.slice('base64://'.length), 'base64').toString(), 'CMD-MP3')
})

test('/语音 命令：合成失败给软文案（不抛异常）', async (t) => {
  const m = createVoiceModule({
    ctx: {},
    cfg: baseCfg({ voice: { ...baseCfg().voice, tts: { ...baseCfg().voice.tts, provider: 'openai', openai: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', voice: 'v', format: 'mp3' } } } }),
    logger: quietLog,
    stateDir: makeTempDir(t),
  })
  const reply = await m.commands['语音']({}, 'p', ['你好'])
  assert.match(reply, /嗓子哑了/)
})
