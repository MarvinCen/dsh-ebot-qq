/**
 * lib/ui-api.mjs —— 设置面板的后端（/api/ebot-qq/*）
 * ----------------------------------------------------------------------------
 * 桌面版设置页没有官方「插件配置」RPC（settings-controller 未组装），
 * 所以照 dsh-bili-scroll 验证过的模式：host 注册一条 Web 路由给面板用。
 *
 * 读/写都走 DSH 官方 settings 服务（ctx.get('settings')）：
 *   - GET  /api/ebot-qq/config  → describe({redactSecrets}) 的纯值 + secret 状态
 *   - POST /api/ebot-qq/config  → 校验合并后的配置，合法才 settings.update（热更新），
 *                                 冲突回 409，校验失败回 400 + 逐字段错误
 * 安全：与 bili-scroll 同款双层 —— DSH 信任栅栏（connection.requestRejection）
 *        + 本机同源检查，浏览器（带会话）能过，裸脚本/外部网页过不了。
 */
import { resolveConfig, deepMerge } from './config.mjs'

const NS = 'ebot-qq'

/**
 * 本机同源检查（纯函数，便于单测）。
 * Host 是 loopback 且（无 Origin/Referer，或与 Host 同源）才放行。
 */
export function sameOriginOk(hostHeader, originHeader, refererHeader) {
  if (!hostHeader) return true
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHeader)) return false
  const pick = originHeader || refererHeader || ''
  if (!pick) return true
  try {
    const u = new URL(pick)
    const originAuthority = String(u.host || '').toLowerCase()
    if (originAuthority && originAuthority === String(hostHeader).toLowerCase()) return true
    const defaultPort = u.protocol === 'https:' ? '443' : '80'
    const withPort = `${u.hostname}:${u.port || defaultPort}`.toLowerCase()
    return withPort === String(hostHeader).toLowerCase()
  } catch { return false }
}

/** 读请求体（限 1MB，防呆）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() }
    })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })
}

/**
 * 面板可调用的 API 核心（ctx 只用来 get('settings') / get('connection')，便于测试注入）。
 */
export function createUiApi({ ctx, logger }) {
  const log = logger || { debug() {}, info() {}, warn() {}, error() {} }
  const getSettings = () => ctx?.get?.('settings') ?? null

  function currentRow(redact = true) {
    const settings = getSettings()
    if (!settings || typeof settings.describe !== 'function') return null
    const list = settings.describe(redact ? { redactSecrets: true } : {})
    return list?.find?.((d) => d.ns === NS) ?? null
  }

  /** GET：当前配置纯值（合并默认值）+ 校验错误 + secret 状态。 */
  async function getConfig() {
    const row = currentRow()
    if (!row) return { ok: false, error: 'settings 服务不可用或没找到本插件条目' }
    const { config, errors } = resolveConfig(row.value)
    const secrets = Object.fromEntries((row.secrets ?? []).map((x) => [x.path.join('.'), x.set]))
    return { ok: true, config, errors, secrets, revision: row.revision }
  }

  /** POST：校验通过才写 settings.update（热更新）。 */
  async function setConfig(body) {
    const settings = getSettings()
    const row = currentRow()
    if (!settings || !row) return { ok: false, error: 'settings 服务不可用或没找到本插件条目' }
    const patch = body?.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch 必须是对象' }
    }
    const merged = deepMerge(row.value, patch)
    const { errors } = resolveConfig(merged)
    if (errors.length) return { ok: false, errors }
    try {
      await settings.update(NS, patch, row.revision)
    } catch (e) {
      if (e?.code === 'SETTINGS_CONFLICT') return { ok: false, conflict: true, error: '配置刚被别处改过，页面将刷新，请重试' }
      throw e
    }
    log.info(`设置已保存：${JSON.stringify(patch).slice(0, 200)}`)
    return { ok: true }
  }

  /** 组装成 webServer 路由处理器（fence 逻辑与 bili-scroll 同款）。 */
  function makeHandler() {
    return async (req, res) => {
      const send = (code, obj) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        } catch { /* 连接已断 */ }
      }
      // ① DSH 信任栅栏（浏览器会话才放行）
      const conn = ctx?.get?.('connection')
      if (conn && typeof conn.requestRejection === 'function') {
        let rejection
        try { rejection = conn.requestRejection({ headers: req.headers }) } catch {
          send(403, { ok: false, error: '被宿主拦截' })
          return
        }
        if (rejection !== undefined) { send(rejection, { ok: false, error: '未授权' }); return }
      }
      // ② 本机同源兜底
      if (!sameOriginOk(String(req.headers.host || ''), String(req.headers.origin || ''), String(req.headers.referer || ''))) {
        send(403, { ok: false, error: '只接受本机同源请求' })
        return
      }
      let url
      try { url = new URL(req.url, 'http://127.0.0.1') } catch { send(400, { ok: false, error: 'URL 解析失败' }); return }
      try {
        if (req.method === 'GET' && url.pathname === '/api/ebot-qq/config') return send(200, await getConfig())
        if (req.method === 'POST' && url.pathname === '/api/ebot-qq/config') {
          const body = await readBody(req)
          const r = await setConfig(body)
          if (r.conflict) return send(409, r)
          if (r.errors) return send(400, r)
          if (!r.ok) return send(500, r)
          return send(200, r)
        }
        return send(404, { ok: false, error: `unknown ${req.method} ${url.pathname}` })
      } catch (e) {
        log.warn(`设置页 API 出错：${e?.stack ?? e}`)
        send(500, { ok: false, error: String(e?.message ?? e) })
      }
    }
  }

  return { getConfig, setConfig, makeHandler }
}

/** 挂路由（在 apply 里调用）。 */
export function registerUiApi(ctx, cfg, logger) {
  const api = createUiApi({ ctx, logger })
  try {
    ctx.effect(() => {
      const off = ctx.webServer.register({ kind: 'prefix', path: '/api/ebot-qq', handler: api.makeHandler() })
      logger?.info?.('设置面板路由已挂载：/api/ebot-qq/config')
      return () => { try { off() } catch { /* 卸载 */ } }
    }, 'ebot-qq: 设置面板路由')
  } catch (e) {
    logger?.warn?.(`设置面板路由没挂上：${e?.message ?? e}`)
  }
  return api
}
