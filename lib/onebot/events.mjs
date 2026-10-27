/**
 * lib/onebot/events.mjs —— OneBot 11 事件归一化
 * ----------------------------------------------------------------------------
 * OneBot 11 的原始事件包字段名是 snake_case（message_id / user_id / raw_message…）。
 * 业务层（chat/memory/…）只跟这里归一化后的 camelCase 结构打交道，
 * 这样以后即使换协议端（如 Lagrange 的字段差异）也只改这一层。
 */
import { OneBotError } from './client.mjs'

/**
 * 把一条原始事件包归一化。只做「结构翻译」，不做业务判断。
 * @param {object} raw OneBot 11 事件包（已 JSON.parse）
 * @returns 归一化事件；不认识的包返回 { type: 'unknown', raw }，绝不抛错
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return { type: 'unknown', raw }
  const postType = raw.post_type
  if (postType === 'message') return normalizeMessage(raw)
  if (postType === 'notice') return normalizeNotice(raw)
  if (postType === 'request') return normalizeRequest(raw)
  if (postType === 'meta_event') return { type: 'meta', metaType: raw.meta_event_type, raw }
  return { type: 'unknown', raw }
}

function normalizeMessage(raw) {
  const segments = Array.isArray(raw.message) ? raw.message : []
  const base = {
    type: 'message',
    subType: raw.message_type === 'group' ? 'group' : 'private',
    messageId: raw.message_id,
    userId: raw.user_id,
    time: raw.time,
    segments,
    text: extractText(segments),
    raw,
  }
  if (raw.message_type === 'group') {
    base.groupId = raw.group_id
    base.senderName = raw.sender?.nickname ?? raw.sender?.card ?? ''
  } else {
    base.senderName = raw.sender?.nickname ?? ''
  }
  return base
}

function normalizeNotice(raw) {
  return {
    type: 'notice',
    noticeType: raw.notice_type,
    userId: raw.user_id ?? raw.operator_id,
    groupId: raw.group_id,
    raw,
  }
}

function normalizeRequest(raw) {
  return {
    type: 'request',
    requestType: raw.request_type,
    userId: raw.user_id,
    groupId: raw.group_id,
    flag: raw.flag,
    raw,
  }
}

/** 从 CQ 段里拼出纯文本（聊天只认文字，图片/表情段保留在 segments 里给别的模块用）。 */
export function extractText(segments) {
  let out = ''
  for (const seg of segments ?? []) {
    if (seg?.type === 'text') out += seg.data?.text ?? ''
  }
  return out
}

/**
 * 构造回复用的 CQ 消息。支持：
 *   - 字符串 → 原样返回；
 *   - 对象 { text, image?, record?, face?, atUser? } → 拼 CQ 码；
 *   - 数组（CQ 段）→ 原样返回（高级用法）。
 * 私聊不解析 at（会报错），所以 at 只在群聊场景由调用方带上。
 */
export function buildMessage(input) {
  if (Array.isArray(input)) return input
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') throw new OneBotError('EBOT-BAD-MESSAGE', '无法识别的回复消息形态')
  const parts = []
  if (input.atUser) parts.push({ type: 'at', data: { qq: String(input.atUser) } })
  if (input.image) parts.push({ type: 'image', data: { file: input.image } })
  if (input.record) parts.push({ type: 'record', data: { file: input.record } })
  if (input.face !== undefined) parts.push({ type: 'face', data: { id: String(input.face) } })
  if (input.text) parts.push({ type: 'text', data: { text: input.text } })
  return parts
}
