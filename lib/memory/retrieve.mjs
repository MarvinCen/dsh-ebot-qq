/**
 * lib/memory/retrieve.mjs —— 长期记忆检索
 * ----------------------------------------------------------------------------
 * 两条检索路线（按配置自动选择）：
 *   1. 向量检索（memory.embedding 三件套都配了）：
 *      query 和每条记忆都过 embedding API，按余弦相似度取 topK，低于 minScore 丢弃；
 *   2. 关键词检索（没配 embedding）：
 *      中文友好打分 —— 整词命中 + 二字滑动窗口重合度，按分数取 topK。
 * 两条路线输出同一种格式：数组 [{ fact, score }]。
 */

/** 把文本切成检索单元：整词（长度>2）+ 二字窗口。 */
export function tokens(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) return []
  const out = []
  if (s.length > 2) out.push(s)
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2))
  return out
}

/** 关键词打分：重合单元数占比越高分越高。 */
export function keywordScore(query, factText) {
  const q = tokens(query)
  const f = new Set(tokens(factText))
  if (!q.length || !f.size) return 0
  const hits = q.filter((t) => f.has(t)).length
  return hits / q.length
}

/** 余弦相似度。 */
export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * OpenAI 兼容 embedding 请求（单个 query）。
 * @returns Promise<number[]>；失败抛 LlmError 风格的错误（带 code）
 */
export async function embedOnce({ baseUrl, apiKey, model, input, timeoutMs = 15000 }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/embeddings'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const err = new Error(`embedding HTTP ${res.status}`)
    err.code = `EBOT-EMB-HTTP-${res.status}`
    throw err
  }
  const json = await res.json()
  const vec = json?.data?.[0]?.embedding
  if (!Array.isArray(vec)) throw Object.assign(new Error('embedding 响应缺 data[0].embedding'), { code: 'EBOT-EMB-EMPTY' })
  return vec
}

/**
 * 检索入口。
 * @param {object} opts { query, store, embedding? {baseUrl,apiKey,model,topK,minScore}, logger }
 * @returns Promise<Array<{fact, score}>>，按分数降序
 */
export async function retrieveMemory(opts) {
  const query = String(opts.query ?? '').trim()
  const facts = opts.store.list()
  if (!query || !facts.length) return []
  const topK = Number(opts.embedding?.topK ?? 6)

  if (opts.embedding?.baseUrl && opts.embedding?.apiKey && opts.embedding?.model) {
    return retrieveVector(opts, query, facts, topK)
  }
  return retrieveKeyword(query, facts, topK)
}

/** 关键词路线：同步即可完成。 */
export function retrieveKeyword(query, facts, topK = 6) {
  return facts
    .map((fact) => ({ fact, score: keywordScore(query, fact.text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** 向量路线：先向量化 query，再逐条比较已有向量（没有向量的条目现场补算）。 */
export async function retrieveVector(opts, query, facts, topK) {
  const emb = opts.embedding
  const qv = await embedOnce({ baseUrl: emb.baseUrl, apiKey: emb.apiKey, model: emb.model, input: query })
  const scored = []
  for (const fact of facts) {
    let fv = fact.embedding
    if (!Array.isArray(fv) || !fv.length) {
      try {
        fv = await embedOnce({ baseUrl: emb.baseUrl, apiKey: emb.apiKey, model: emb.model, input: fact.text })
        fact.embedding = fv
        opts.store.add(fact.text, { embedding: fv, kind: fact.kind }) // add 会去重合并并落盘
      } catch (e) {
        opts.logger?.warn?.(`记忆向量化失败（${fact.id}）：${e?.message ?? e}`)
        continue
      }
    }
    scored.push({ fact, score: cosine(qv, fv) })
  }
  return scored
    .filter((x) => x.score >= Number(emb.minScore ?? 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** 检索结果 → 注入提示词的文本。 */
export function formatFacts(scored, limit = 8) {
  return scored.slice(0, limit).map(({ fact }) => `- ${fact.text}`).join('\n')
}
