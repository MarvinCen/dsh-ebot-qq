/**
 * test/ui-api.test.mjs —— 设置面板后端测试
 * 覆盖：同源检查（纯函数）、GET 配置（含 secret 状态与默认值合并）、
 *       POST 保存（合法/校验失败 400/冲突 409/服务缺失）、路由与栅栏（测试原则 5/6/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUiApi, sameOriginOk } from '../lib/ui-api.mjs'
import { DEFAULT_CONFIG } from '../lib/config.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 假 settings 服务（describe/update 可编程）。 */
function fakeSettings({ value = DEFAULT_CONFIG, update, describeOpts } = {}) {
  const calls = { update: [] }
  return {
    calls,
    describe: (opts) => [{
      ns: 'ebot-qq',
      revision: 3,
      value,
      secrets: [
        { path: ['llm', 'apiKey'], set: true },
        { path: ['voice', 'tts', 'openai', 'apiKey'], set: false },
      ],
      ...(describeOpts ?? {}),
    }],
    update: async (ns, patch, rev) => {
      calls.update.push({ ns, patch, rev })
      if (update?.throwConflict && calls.update.length === 1) {
        const e = new Error('冲突')
        e.code = 'SETTINGS_CONFLICT'
        throw e
      }
      if (update?.throwOther) throw new Error('写坏了')
    },
  }
}

const apiFor = (settings) => createUiApi({ ctx: { get: (n) => (n === 'settings' ? settings : undefined) }, logger: quietLog })

test('sameOriginOk：loopback 无 Origin 放行、同源放行、外部拒绝', () => {
  assert.equal(sameOriginOk('127.0.0.1:50333', '', ''), true)
  assert.equal(sameOriginOk('localhost:50333', 'http://localhost:50333', ''), true)
  assert.equal(sameOriginOk('127.0.0.1:50333', 'http://127.0.0.1:50333', ''), true)
  assert.equal(sameOriginOk('127.0.0.1:50333', 'http://evil.example.com', ''), false, '外部 Origin 拒绝')
  assert.equal(sameOriginOk('evil.example.com', '', ''), false, '非 loopback Host 拒绝')
  assert.equal(sameOriginOk('', 'http://127.0.0.1:50333', ''), true, '无 Host 头（非浏览器/内部）放行')
  assert.equal(sameOriginOk('127.0.0.1:50333', 'http://127.0.0.1:9999', ''), false, '同机不同端口拒绝')
})

test('GET：返回合并默认值后的配置、secret 状态与 revision', async () => {
  const api = apiFor(fakeSettings({ value: { onebot: { url: 'ws://x:1' } } }))
  const r = await api.getConfig()
  assert.equal(r.ok, true)
  assert.equal(r.config.onebot.url, 'ws://x:1')
  assert.equal(r.config.llm.model, DEFAULT_CONFIG.llm.model, '缺失字段用默认值补齐')
  assert.equal(r.secrets['llm.apiKey'], true)
  assert.equal(r.secrets['voice.tts.openai.apiKey'], false)
  assert.equal(r.revision, 3)
})

test('GET：settings 服务缺失返回 ok:false', async () => {
  const api = createUiApi({ ctx: { get: () => undefined }, logger: quietLog })
  const r = await api.getConfig()
  assert.equal(r.ok, false)
})

test('POST：合法 patch 走 settings.update（带 revision）', async () => {
  const settings = fakeSettings()
  const api = apiFor(settings)
  const r = await api.setConfig({ patch: { llm: { apiKey: 'sk-x' } } })
  assert.equal(r.ok, true)
  assert.deepEqual(settings.calls.update[0], { ns: 'ebot-qq', patch: { llm: { apiKey: 'sk-x' } }, rev: 3 })
})

test('POST：非法 patch 返回 errors 且不写 settings', async () => {
  const settings = fakeSettings()
  const api = apiFor(settings)
  const r = await api.setConfig({ patch: { onebot: { url: 'http://坏地址' } } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === 'onebot.url'), '应报字段级错误')
  assert.equal(settings.calls.update.length, 0, '校验不过不能写')
})

test('POST：patch 不是对象返回 ok:false', async () => {
  const api = apiFor(fakeSettings())
  for (const bad of [undefined, null, [1], 'x']) {
    const r = await api.setConfig({ patch: bad })
    assert.equal(r.ok, false)
  }
})

test('POST：SETTINGS_CONFLICT 转成 conflict 标记', async () => {
  const settings = fakeSettings({ update: { throwConflict: true } })
  const api = apiFor(settings)
  const r = await api.setConfig({ patch: { persona: { name: '肥仔' } } })
  assert.equal(r.conflict, true)
  assert.match(r.error, /别处改过/)
})

test('POST：update 其他异常向上抛（由路由层转 500）', async () => {
  const settings = fakeSettings({ update: { throwOther: true } })
  const api = apiFor(settings)
  await assert.rejects(api.setConfig({ patch: { persona: { name: 'x' } } }), /写坏了/)
})

// ─────────────── 路由层（fence + 分发）───────────────

/** 假请求/响应，把路由当函数直接调用（req 支持 data/end 事件，POST body 可喂）。 */
function fakeReqRes({ method = 'GET', path = '/api/ebot-qq/config', headers = {}, body } = {}) {
  const listeners = {}
  const req = {
    method,
    url: path,
    headers,
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return req },
    _feed: (text) => {
      for (const fn of listeners['data'] ?? []) fn(Buffer.from(text))
      for (const fn of listeners['end'] ?? []) fn()
    },
    destroy() {},
  }
  const res = {
    statusCode: 200,
    body: '',
    writeHead(code) { this.statusCode = code },
    end(s) { this.body = s },
  }
  return {
    req,
    res,
    async run(handler) {
      const p = handler(req, res)
      if (body !== undefined) req._feed(body)
      await p
      return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
    },
  }
}

function makeHandlerCtx(settings, connection) {
  return { get: (n) => (n === 'settings' ? settings : n === 'connection' ? connection : undefined) }
}

test('路由：GET /config 200；未知路径 404', async () => {
  const handler = apiFor(fakeSettings()).makeHandler()
  const ok = await fakeReqRes().run(handler)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  const missing = await fakeReqRes({ path: '/api/ebot-qq/nope' }).run(handler)
  assert.equal(missing.status, 404)
})

test('路由：校验失败回 400 + errors；冲突回 409', async () => {
  const handler = apiFor(fakeSettings()).makeHandler()
  const bad = await fakeReqRes({ method: 'POST', body: JSON.stringify({ patch: { onebot: { url: 'ftp://x' } } }) }).run(handler)
  assert.equal(bad.status, 400)
  assert.ok(bad.body.errors.some((e) => e.path === 'onebot.url'))
  const conflictHandler = apiFor(fakeSettings({ update: { throwConflict: true } })).makeHandler()
  const conflict = await fakeReqRes({ method: 'POST', body: JSON.stringify({ patch: { persona: { name: 'x' } } }) }).run(conflictHandler)
  assert.equal(conflict.status, 409)
})

test('路由：信任栅栏拒绝时回拒绝码，不再进业务', async () => {
  const api = createUiApi({ ctx: makeHandlerCtx(fakeSettings(), { requestRejection: () => 401 }), logger: quietLog })
  const r = await fakeReqRes().run(api.makeHandler())
  assert.equal(r.status, 401)
})

test('路由：栅栏不可用但非同源请求回 403', async () => {
  const api = createUiApi({ ctx: makeHandlerCtx(fakeSettings(), null), logger: quietLog })
  const r = await fakeReqRes({ headers: { host: '127.0.0.1:1', origin: 'http://evil.com' } }).run(api.makeHandler())
  assert.equal(r.status, 403)
})

test('路由：栅栏不可用、loopback 无 Origin（本机脚本）可访问', async () => {
  const api = createUiApi({ ctx: makeHandlerCtx(fakeSettings(), null), logger: quietLog })
  const r = await fakeReqRes({ headers: { host: '127.0.0.1:1' } }).run(api.makeHandler())
  assert.equal(r.status, 200)
})
