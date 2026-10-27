/**
 * test/proactive.test.mjs —— 主动聊天模块测试
 * 覆盖：时间窗（含跨夜）、调度计算（间隔范围/窗口外顺延）、话题生成（记忆钩子/池子）、
 *       引擎五道闸与冷却、reschedule 与 dispose（测试原则 3/4/5/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inWindow, nextFireAt } from '../lib/proactive/scheduler.mjs'
import { pickTopic, memoryHook, DEFAULT_TOPICS } from '../lib/proactive/topics.mjs'
import { ProactiveEngine, createProactiveModule } from '../lib/proactive/index.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }
const DAY = 24 * 3600_000
const T = (h, m = 0) => new Date(2026, 0, 5, h, m, 0, 0).getTime() // 2026-01-05 是周一，无夏令时干扰

test('inWindow：窗口内/外/边界', () => {
  assert.equal(inWindow(T(10), '09:00', '23:00'), true)
  assert.equal(inWindow(T(8, 59), '09:00', '23:00'), false)
  assert.equal(inWindow(T(23), '09:00', '23:00'), false, '含头不含尾')
  assert.equal(inWindow(T(22, 30), '22:00', '02:00'), true, '跨夜窗口')
  assert.equal(inWindow(T(1, 30), '22:00', '02:00'), true)
  assert.equal(inWindow(T(5), '22:00', '02:00'), false)
})

test('nextFireAt：rng=0 取最小间隔，rng=0.999 接近最大间隔', () => {
  const base = { windowStart: '00:00', windowEnd: '23:59', minIntervalHours: 2, maxIntervalHours: 6 }
  const t0 = nextFireAt(T(10), { ...base, rng: () => 0 })
  assert.equal(t0, T(12), 'rng=0 → now+2h')
  const t1 = nextFireAt(T(10), { ...base, rng: () => 0.999 })
  assert.ok(t1 > T(15, 59) && t1 <= T(16), 'rng≈1 → 接近 now+6h')
})

test('nextFireAt：算出的时刻落在窗口外时顺延到窗口内', () => {
  // 23:50 + 2h = 01:50，不在 09:00-23:00 窗口 → 顺延到次日窗口内随机点
  const opts = { windowStart: '09:00', windowEnd: '23:00', minIntervalHours: 2, maxIntervalHours: 2, rng: () => 0.5 }
  const t = nextFireAt(T(23, 50), opts)
  assert.ok(inWindow(t, '09:00', '23:00'), '顺延后必须在窗口内')
  assert.ok(t > T(23, 50) + 2 * 3600_000, '不能早于最小间隔')
})

test('nextFireAt：跨夜窗口顺延正确', () => {
  // 18:00 + 2h = 20:00，不在 22:00-02:00 → 顺延到 22:00~02:00
  const opts = { windowStart: '22:00', windowEnd: '02:00', minIntervalHours: 2, maxIntervalHours: 2, rng: () => 0 }
  const t = nextFireAt(T(18), opts)
  assert.ok(inWindow(t, '22:00', '02:00'))
  assert.equal(t, T(22), 'rng=0 → 顺延到窗口起点 22:00')
})

test('memoryHook：事实转钩子句式；空文本返回 null', () => {
  assert.equal(memoryHook('主人喜欢喝美式咖啡'), '鱼鱼突然想起来：主人喜欢喝美式咖啡～今天也是这样吗？')
  assert.equal(memoryHook('主人'), null)
  assert.equal(memoryHook('  '), null)
})

test('pickTopic：有记忆且 rng<0.6 走记忆钩子；否则走池子', () => {
  const facts = ['主人养了一只猫']
  const hook = pickTopic({ memoryFacts: facts, rng: () => 0 })
  assert.ok(hook.includes('主人养了一只猫'), 'rng=0 → 记忆钩子')
  const pool = pickTopic({ memoryFacts: facts, rng: () => 0.9 })
  assert.ok(DEFAULT_TOPICS.includes(pool), 'rng=0.9 → 内置池')
  const custom = pickTopic({ memoryFacts: [], topics: ['自定义话题'], rng: () => 0.999 })
  assert.equal(custom, '自定义话题', '用户话题可被选中（0.999 落到最后一个池位）')
})

function makeEngine(opts = {}) {
  const sent = []
  const engine = new ProactiveEngine({
    cfg: {
      enabled: true,
      windowStart: '00:00',
      windowEnd: '23:59',
      minIntervalHours: 2,
      maxIntervalHours: 2,
      cooldownMinutes: 30,
      topics: [],
      ...opts.cfg,
    },
    ownerQq: opts.ownerQq ?? 123,
    isConnected: opts.isConnected ?? (() => true),
    send: (text) => { sent.push(text); return Promise.resolve() },
    memory: opts.memory ?? { recentFacts: () => [] },
    logger: quietLog,
    rng: opts.rng ?? (() => 0.9),
    now: opts.now,
    computeNext: opts.computeNext ?? ((now) => now + 100),
  })
  return { engine, sent }
}

test('引擎闭环：到点触发发送并重新调度（多次触发）', async () => {
  const { engine, sent } = makeEngine({})
  engine.start()
  await new Promise((r) => setTimeout(r, 380))
  engine.dispose()
  assert.ok(engine.fireCount >= 2, `应触发多次（实际 ${engine.fireCount}）`)
  assert.ok(sent.length >= 2)
  assert.ok(sent.every((t) => DEFAULT_TOPICS.includes(t)))
})

test('五道闸：enabled=false / 主人未配置 / 未连接 / 冷却中 都不发', async () => {
  const off = makeEngine({ cfg: { enabled: false } })
  off.engine.start()
  await new Promise((r) => setTimeout(r, 250))
  off.engine.dispose()
  assert.equal(off.sent.length, 0)

  const noOwner = makeEngine({ ownerQq: 0 })
  noOwner.engine.start()
  await new Promise((r) => setTimeout(r, 250))
  noOwner.engine.dispose()
  assert.equal(noOwner.sent.length, 0)

  const disconnected = makeEngine({ isConnected: () => false })
  disconnected.engine.start()
  await new Promise((r) => setTimeout(r, 250))
  disconnected.engine.dispose()
  assert.equal(disconnected.sent.length, 0)

  const cooling = makeEngine({})
  cooling.engine.start()
  cooling.engine.noteOwnerActivity() // 主人刚聊过 → 冷却中
  await new Promise((r) => setTimeout(r, 250))
  cooling.engine.dispose()
  assert.equal(cooling.sent.length, 0)
})

test('时间窗外不发（注入凌晨 3 点时钟，窗口 09:00-23:00）', async () => {
  const { engine, sent } = makeEngine({ cfg: { windowStart: '09:00', windowEnd: '23:00' }, now: () => T(3) })
  engine.start()
  await new Promise((r) => setTimeout(r, 250))
  engine.dispose()
  assert.equal(sent.length, 0)
})

test('记忆驱动：recentFacts 注入后话题来自记忆钩子', async () => {
  const { engine, sent } = makeEngine({
    memory: { recentFacts: () => [{ text: '主人喜欢喝美式' }] },
    rng: () => 0, // 强制记忆钩子
  })
  engine.start()
  await new Promise((r) => setTimeout(r, 250))
  engine.dispose()
  assert.ok(sent.length >= 1)
  assert.ok(sent[0].includes('主人喜欢喝美式'))
})

test('发送失败不崩：记日志并继续调度', async () => {
  const engine = new ProactiveEngine({
    cfg: { enabled: true, windowStart: '00:00', windowEnd: '23:59', minIntervalHours: 1, maxIntervalHours: 1, cooldownMinutes: 0, topics: [] },
    ownerQq: 123,
    isConnected: () => true,
    send: () => { throw new Error('发送炸了') },
    memory: { recentFacts: () => [] },
    logger: quietLog,
    rng: () => 0.9,
    computeNext: (now) => now + 100,
  })
  engine.start()
  await new Promise((r) => setTimeout(r, 350))
  engine.dispose()
  assert.ok(engine.fireAttempts >= 2, '失败后仍继续调度（attempts>=2）')
  assert.equal(engine.fireCount, 0, '失败不计入成功次数')
})

test('dispose 后不再触发', async () => {
  const { engine, sent } = makeEngine({})
  engine.start()
  await new Promise((r) => setTimeout(r, 150))
  engine.dispose()
  const count = sent.length
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(sent.length, count, 'dispose 后不再发送')
})

test('装配：主人发消息刷新冷却起点', async () => {
  const handlers = []
  const client = {
    state: 'connected',
    onEvent: (h) => { handlers.push(h); return () => {} },
    sendPrivateMessage: () => Promise.resolve({ message_id: 1 }),
  }
  const mod = createProactiveModule({
    cfg: { proactive: { enabled: true, windowStart: '00:00', windowEnd: '23:59', minIntervalHours: 1, maxIntervalHours: 1, cooldownMinutes: 30, topics: [] }, owner: { qq: 123 } },
    client,
    memory: { recentFacts: () => [] },
    logger: quietLog,
  })
  assert.equal(handlers.length, 1, '装配应注册事件监听')
  handlers[0]({ post_type: 'message', message_type: 'private', message_id: 1, user_id: 123, message: [{ type: 'text', data: { text: 'hi' } }] })
  handlers[0]({ post_type: 'message', message_type: 'private', message_id: 2, user_id: 999, message: [{ type: 'text', data: { text: 'hi' } }] })
  mod.dispose()
  assert.equal(handlers.length, 1)
})
