/**
 * lib/voice/tts.mjs —— 发语音：文字 → 音频
 * ----------------------------------------------------------------------------
 * 双引擎（用户按需选择，config.voice.tts.provider）：
 *   - piper：本地开源 TTS。spawn `piper --model <模型> --output_file <wav>`，文本走 stdin；
 *   - openai：OpenAI 兼容 audio/speech API（OpenAI / MiniMax 等，换 baseUrl 即换服务商）；
 *   - off：不发语音。
 *
 * 输出统一为 { data: Uint8Array, format }，format ∈ 'wav' | 'mp3'。
 * 所有失败抛带稳定 code 的 VoiceError；合成前先截断文本（QQ 语音有长度上限）。
 */

const MAX_TTS_CHARS = 150

export class TtsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TtsError'
    this.code = code
  }
}

/** 合成前截断：150 字后直接砍掉（按句子边界尽量自然）。 */
export function truncateForTts(text) {
  const src = String(text ?? '').trim()
  if (src.length <= MAX_TTS_CHARS) return src
  const cut = src.lastIndexOf('。', MAX_TTS_CHARS)
  return (cut > MAX_TTS_CHARS / 2 ? src.slice(0, cut + 1) : src.slice(0, MAX_TTS_CHARS))
}

/**
 * Piper 本地合成。
 * @param {object} opts { bin, model, text, spawnImpl?, tmpFile }
 * @returns Promise<{ data, format: 'wav' }>
 */
export async function ttsPiper(opts) {
  const bin = String(opts.bin || 'piper')
  const model = String(opts.model || '')
  if (!model) throw new TtsError('EBOT-TTS-PIPER-NO-MODEL', 'Piper 模型文件未配置')
  const { spawn } = await import('node:child_process')
  const tmpFile = opts.tmpFile
  const args = ['--model', model, '--output_file', tmpFile]
  await new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    child.on('error', (e) => reject(new TtsError('EBOT-TTS-PIPER-SPAWN', `Piper 启动失败：${e?.message ?? e}（bin=${bin}）`)))
    child.stderr.on('data', (c) => { stderr += c })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new TtsError('EBOT-TTS-PIPER-FAILED', `Piper 合成失败（exit ${code}）：${stderr.slice(-200)}`))
    })
    child.stdin.on('error', () => { /* 管道错误由 exit 收尾 */ })
    child.stdin.end(opts.text)
  })
  const { readFileSync } = await import('node:fs')
  let data
  try { data = new Uint8Array(readFileSync(tmpFile)) } catch (e) {
    throw new TtsError('EBOT-TTS-PIPER-OUTPUT', `读 Piper 输出失败：${e?.message ?? e}`)
  }
  if (!data.length) throw new TtsError('EBOT-TTS-EMPTY', 'Piper 没有产出音频')
  return { data, format: 'wav' }
}

/**
 * OpenAI 兼容云端合成（POST {baseUrl}/audio/speech）。
 * @returns Promise<{ data, format }>
 */
export async function ttsOpenai(opts) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) throw new TtsError('EBOT-TTS-OPENAI-NO-URL', '云端 TTS 的 baseUrl 未配置')
  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify({
      model: opts.model || 'tts-1',
      voice: opts.voice || 'alloy',
      input: opts.text,
      response_format: opts.format || 'mp3',
    }),
    signal: AbortSignal.timeout(Number(opts.timeoutMs ?? 30000)),
  }).catch((e) => {
    throw new TtsError(e?.name === 'TimeoutError' ? 'EBOT-TTS-TIMEOUT' : 'EBOT-TTS-NETWORK', `云端 TTS 请求失败：${e?.message ?? e}`)
  })
  if (!res.ok) {
    throw new TtsError(`EBOT-TTS-HTTP-${res.status}`, `云端 TTS 失败（HTTP ${res.status}）`)
  }
  const data = new Uint8Array(await res.arrayBuffer())
  if (!data.length) throw new TtsError('EBOT-TTS-EMPTY', '云端 TTS 返回空音频')
  return { data, format: String(opts.format || 'mp3') }
}

/**
 * 统一入口：按 provider 路由。
 * @param {object} opts { provider, text, piper:{bin,model,tmpFile}, openai:{...} }
 */
export async function synthText(opts) {
  const text = truncateForTts(opts.text)
  if (!text) throw new TtsError('EBOT-TTS-EMPTY', '没有可合成的文本')
  if (opts.provider === 'piper') return ttsPiper({ ...opts.piper, text })
  if (opts.provider === 'openai') return ttsOpenai({ ...opts.openai, text })
  throw new TtsError('EBOT-TTS-PROVIDER-OFF', `TTS 未启用（provider=${opts.provider}）`)
}
