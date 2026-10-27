/**
 * lib/voice/stt.mjs —— 收语音：QQ 语音 → 文字
 * ----------------------------------------------------------------------------
 * 链路：OneBot record 段 → 取到音频字节（base64 / URL 下载 / 本地文件）→
 *       Harness speechToText 服务转写 → 文本交给 chat。
 *
 * speechToText 是**可选服务**（ctx.get('speechToText') 可能拿不到），
 * 拿不到/转写失败都抛带稳定 code 的 VoiceError，由上层给软文案。
 */
import { readFileSync } from 'node:fs'

export class VoiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VoiceError'
    this.code = code
  }
}

/**
 * 从 CQ record 段的 file 字段取音频字节。
 * 支持三种来源：base64:// / http(s):// / file:// 或裸本地路径。
 * @param {string} file record 段的 file 值
 * @param {object} [opts] { timeoutMs=20000, fetchImpl=fetch }
 */
export async function resolveRecordBytes(file, opts = {}) {
  const src = String(file ?? '')
  const timeoutMs = Number(opts.timeoutMs ?? 20000)
  const fetchImpl = opts.fetchImpl ?? fetch
  if (src.startsWith('base64://')) {
    const buf = Buffer.from(src.slice('base64://'.length), 'base64')
    if (!buf.length) throw new VoiceError('EBOT-STT-BAD-RECORD', '语音数据是空的')
    return new Uint8Array(buf)
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const res = await fetchImpl(src, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new VoiceError(`EBOT-STT-HTTP-${res.status}`, `下载语音失败（HTTP ${res.status}）`)
      const buf = new Uint8Array(await res.arrayBuffer())
      if (!buf.length) throw new VoiceError('EBOT-STT-EMPTY', '下载到的语音是空的')
      return buf
    } catch (e) {
      if (e instanceof VoiceError) throw e
      if (e?.name === 'TimeoutError') throw new VoiceError('EBOT-STT-TIMEOUT', '下载语音超时')
      throw new VoiceError('EBOT-STT-NETWORK', `下载语音失败：${e?.message ?? e}`)
    }
  }
  const path = src.startsWith('file://') ? src.slice('file://'.length) : src
  if (!path) throw new VoiceError('EBOT-STT-BAD-RECORD', 'record 段没有可用的 file 地址')
  try {
    return new Uint8Array(readFileSync(path))
  } catch (e) {
    throw new VoiceError('EBOT-STT-FILE', `读语音文件失败：${e?.message ?? e}`)
  }
}

/**
 * 用 Harness 转写服务把音频转成文字。
 * @param {object} ctx 插件 ctx（从这里 get('speechToText')）
 * @param {Uint8Array} audio 音频字节
 * @param {object} [opts] { timeoutMs=60000 }
 * @returns Promise<{ text }>
 */
export async function sttTranscribe(ctx, audio, opts = {}) {
  const stt = ctx?.get?.('speechToText')
  if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
    throw new VoiceError('EBOT-STT-UNAVAILABLE', '转写服务不可用')
  }
  const timeoutMs = Number(opts.timeoutMs ?? 60000)
  const spec = stt.resolve({ audio })
  const signal = AbortSignal.timeout(timeoutMs)
  const { text } = await stt.transcribe(spec, signal)
  if (!String(text ?? '').trim()) throw new VoiceError('EBOT-STT-EMPTY', '转写结果为空')
  return { text: String(text).trim() }
}
