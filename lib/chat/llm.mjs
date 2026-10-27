/**
 * lib/chat/llm.mjs —— OpenAI 兼容 chat 客户端
 * ----------------------------------------------------------------------------
 * 大肥鱼的脑子。只管「发请求拿回一段话」，不做业务：
 *   - POST {baseUrl}/chat/completions（OpenAI 兼容协议，DeepSeek/OpenAI/Moonshot 都行）
 *   - 重试策略：网络错误 / 5xx / 超时最多重试 2 次（指数退避），4xx 不重试（重试也没用）
 *   - 兼容 reasoning 模型：content 为空时退回 reasoning_content
 *   - 所有失败都是带稳定 code 的 LlmError，上层按码给用户软文案
 */
export class LlmError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LlmError'
    this.code = code
  }
}

const RETRYABLE = new Set(['EBOT-LLM-NETWORK', 'EBOT-LLM-TIMEOUT', 'EBOT-LLM-HTTP-5XX'])

export class LlmClient {
  /** @param {object} opts { baseUrl, apiKey, model, timeoutMs, logger, retries=2 } */
  constructor(opts) {
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '')
    this.apiKey = String(opts.apiKey || '')
    this.model = String(opts.model || '')
    this.timeoutMs = Number(opts.timeoutMs) || 60000
    this.retries = Number(opts.retries ?? 2)
    this.log = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }
  }

  /**
   * 一轮对话补全。
   * @param {object} req { messages, temperature?, maxTokens?, signal? }
   * @returns Promise<{ text, usage }>
   */
  async chatComplete(req) {
    const body = {
      model: this.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.9,
      max_tokens: req.maxTokens ?? 512,
      stream: false,
    }
    const url = `${this.baseUrl}/chat/completions`
    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let attempt = 0
    for (;;) {
      attempt++
      try {
        return await this._once(url, body, headers, req.signal)
      } catch (err) {
        const retryable = RETRYABLE.has(err?.code)
        if (!retryable || attempt > this.retries) throw err
        const delay = 400 * 2 ** (attempt - 1)
        this.log.warn(`LLM 请求失败（${err.code}），${delay}ms 后第 ${attempt + 1} 次尝试`)
        await sleep(delay, req.signal)
      }
    }
  }

  async _once(url, body, headers, signal) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new LlmError(signal?.aborted ? 'EBOT-LLM-CANCELLED' : 'EBOT-LLM-TIMEOUT', '模型响应超时')
      }
      throw new LlmError('EBOT-LLM-NETWORK', `请求模型失败：${err?.message ?? err}`)
    }
    if (res.status >= 500) {
      throw new LlmError('EBOT-LLM-HTTP-5XX', `模型服务异常（HTTP ${res.status}）`)
    }
    let json = null
    try { json = await res.json() } catch { /* 非 JSON 响应体 */ }
    if (res.status >= 400) {
      const msg = json?.error?.message ?? json?.message ?? `HTTP ${res.status}`
      throw new LlmError(`EBOT-LLM-HTTP-${res.status}`, msg)
    }
    const choice = json?.choices?.[0]?.message ?? {}
    const text = String(choice.content ?? '').trim()
    if (!text) {
      // reasoning 模型（如 deepseek-reasoner）把正文放在 reasoning_content
      const reasoning = String(choice.reasoning_content ?? '').trim()
      if (!reasoning) throw new LlmError('EBOT-LLM-EMPTY', '模型没有返回内容')
      return { text: reasoning, usage: json?.usage ?? null }
    }
    return { text, usage: json?.usage ?? null }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new LlmError('EBOT-LLM-CANCELLED', '已取消')) }, { once: true })
  })
}
