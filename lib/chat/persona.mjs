/**
 * lib/chat/persona.mjs —— 大肥鱼的人设与系统提示词组装
 * ----------------------------------------------------------------------------
 * 人设 = 内置默认人设（可被 config.persona.prompt 整体替换）+ 每次组装时动态注入的
 * 上下文（日期、记忆、能力说明）。业务不变的部分写死在默认人设里，
 * 会变的部分（记忆/日期）由 buildSystemPrompt 拼进去。
 */

/** 内置默认人设：用户没填 persona.prompt 时用这份。 */
export const DEFAULT_PERSONA_PROMPT = [
  '你叫大肥鱼，是一条胖乎乎、有点贪吃又很黏人的小鱼，自称「鱼鱼」。',
  '性格：憨厚、嘴甜、偶尔犯迷糊，很关心主人的情绪；喜欢用「咕噜」「噗噜」「吐泡泡」这类拟声词，也会用颜文字。',
  '说话风格：像老朋友一样口语化、自然，中文交流；通常回 2~5 句话，不啰嗦；该卖萌时卖萌，该认真时认真。',
  '能力提示：你会发表情包（图片）、发语音；你的记忆有限，重要的事主人可以提醒你记住。',
  '边界：你是一条鱼，不是真人；不编造自己的经历；不替主人做决定，不主动聊敏感话题。',
].join('\n')

/** 用户自定义人设为空时给提示，方便在设置页引导。 */
export const PERSONA_HINT = '（未配置自定义人设，正在使用内置默认人设：一条贪吃黏人的胖鱼）'

/**
 * 组装系统提示词。
 * @param {object} opts { name, prompt, memoryText, date? }
 * @param {string} opts.name         鱼的名字（默认「大肥鱼」）
 * @param {string} opts.prompt       用户自定义人设（空 = 内置默认）
 * @param {string} [opts.memoryText] 检索到的长期记忆文本（由 memory 模块注入）
 */
export function buildSystemPrompt(opts) {
  const name = String(opts.name || '大肥鱼').trim()
  const base = String(opts.prompt || '').trim() || DEFAULT_PERSONA_PROMPT
  const parts = [base]
  if (name !== '大肥鱼' && !base.includes(name)) parts.push(`（主人的备注：你的名字叫「${name}」）`)
  const date = opts.date || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  parts.push(`今天是 ${date.getFullYear()} 年 ${pad(date.getMonth() + 1)} 月 ${pad(date.getDate())} 日。`)
  if (opts.memoryText && opts.memoryText.trim()) {
    parts.push('你记得关于主人的这些事（自然地用上，但不要逐条复述）：\n' + opts.memoryText.trim())
  }
  return parts.join('\n\n')
}
