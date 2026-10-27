/**
 * lib/voice/index.mjs —— 语音模块装配：把 stt/tts 接成 chat 的 hooks 与命令
 * ----------------------------------------------------------------------------
 * hooks.stt(event)   record 消息 → 转写文本（未开启/失败返回 null，文案由 chat 决定）
 * hooks.voice(text)  按 config.voice.mode 决定是否给回复配音，返回 record 段 file（base64://）
 * commands.语音      /语音 <文本> —— 强制发一段语音
 */
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { resolveRecordBytes, sttTranscribe } from './stt.mjs'
import { synthText } from './tts.mjs'

export function createVoiceModule({ ctx, cfg, logger, stateDir }) {
  const voiceDir = join(stateDir, 'voice')
  mkdirSync(voiceDir, { recursive: true })

  /** 文字 → record 段 file（base64://）。未配置 TTS 返回 null；失败向上抛。 */
  async function synthToRecord(text) {
    const provider = cfg.voice.tts.provider
    let result
    if (provider === 'piper') {
      const tmp = join(voiceDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`)
      result = await synthText({ provider, text, piper: { bin: cfg.voice.tts.piper.bin, model: cfg.voice.tts.piper.model, tmpFile: tmp } })
      rmSync(tmp, { force: true })
    } else if (provider === 'openai') {
      result = await synthText({ provider, text, openai: cfg.voice.tts.openai })
    } else {
      return null
    }
    return 'base64://' + Buffer.from(result.data).toString('base64')
  }

  return {
    hooks: {
      /** chat 挂点：record 消息 → 转写文本（未开启/失败返回 null，由 chat 决定文案） */
      stt: async (event) => {
        if (!cfg.voice.sttEnabled) return null
        const record = event.segments.find((s) => s?.type === 'record')
        if (!record?.data?.file) return null
        const bytes = await resolveRecordBytes(record.data.file)
        const { text } = await sttTranscribe(ctx, bytes)
        logger.info(`语音转写：${text.slice(0, 40)}`)
        return text
      },
      /** chat 挂点：按 mode 决定是否给回复配音 */
      voice: async (replyText) => {
        if (cfg.voice.mode === 'off') return undefined
        if (cfg.voice.mode === 'smart' && replyText.length > 80) return undefined
        return synthToRecord(replyText)
      },
    },
    commands: {
      语音: async (_event, _peerKey, args) => {
        const text = args.join(' ').trim()
        if (!text) return '在 /语音 后面加上想让我说的话，比如：/语音 主人早上好'
        try {
          const record = await synthToRecord(text)
          if (!record) return '语音功能没开：去设置页把 语音 → TTS 引擎 选 piper 或 openai，再选回复语音模式'
          return { text: '', record }
        } catch (e) {
          logger.warn(`/语音 合成失败：${e?.message ?? e}`)
          return '咕噜……鱼鱼嗓子哑了，语音合成失败（原因已写进日志）'
        }
      },
    },
  }
}
