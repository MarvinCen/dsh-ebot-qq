/**
 * lib/memory/extract.mjs —— 从对话里提取值得记住的事实（用 LLM 干，不硬编码规则）
 * ----------------------------------------------------------------------------
 * 提给模型的是一段「问答对」，模型按 JSON 数组回答 [{text, kind}]：
 *   kind ∈ fact（事实）/ preference（偏好）。
 * 任何解析失败都返回 []（记不住不致命，下轮还有机会）—— 提取是尽力而为。
 */

const EXTRACT_PROMPT = `你是记忆提取器。从下面这段「主人与大肥鱼」的对话里，提取值得长期记住的、关于主人的事实或偏好。
要求：
1. 只输出 JSON 数组，形如 [{"text":"主人喜欢喝美式咖啡","kind":"preference"}]；
2. text 用第三人称（"主人…"），一句话一条，不超过 5 条；
3. 没有值得记的就输出 []；
4. 不记聊天内容本身、不记命令、不记一次性话题；
5. 只输出 JSON，不要任何解释。`

/** 解析模型输出：容错剥掉代码围栏/前后杂字，取最外层 JSON 数组。 */
export function parseFacts(text) {
  const src = String(text ?? '').trim()
  if (!src) return []
  let json = src
  // 剥 ```json ... ``` 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(src)
  if (fence) json = fence[1].trim()
  // 取第一个 [ 到最后一个 ]
  const start = json.indexOf('[')
  const end = json.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(json.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ text: x.text.trim(), kind: x.kind === 'preference' ? 'preference' : 'fact' }))
  } catch { return [] }
}

/**
 * 从一轮对话提取记忆。
 * @param {object} llm LlmClient（与 chat 共用）
 * @param {object} exchange { userText, replyText }
 * @returns Promise<Array<{text, kind}>>（永远不抛错）
 */
export async function extractFacts(llm, exchange, logger = console) {
  try {
    const { text } = await llm.chatComplete({
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `主人说：${exchange.userText}\n大肥鱼说：${exchange.replyText}` },
      ],
      temperature: 0.2,
      maxTokens: 300,
    })
    const facts = parseFacts(text)
    logger.info?.(`记忆提取：从一轮对话里提取到 ${facts.length} 条`)
    return facts
  } catch (e) {
    logger.warn?.(`记忆提取失败（本轮跳过）：${e?.message ?? e}`)
    return []
  }
}
