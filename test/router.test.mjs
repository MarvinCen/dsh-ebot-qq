/**
 * test/router.test.mjs —— 聊天引擎测试
 * 用 FakeClient / FakeLlm 做「消息进 → 回复出」的闭环测试（测试原则 2：完整业务闭环），
 * 覆盖权限、命令、并发忙、软兜底、分段、hooks、meta self_id。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine, splitLongText } from '../lib/chat/router.mjs'
import { SessionStore } from '../lib/chat/session.mjs'
import { LlmError } from '../lib/chat/llm.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

class FakeClient {
  constructor() { this.state = 'connected'; this.handlers = []; this.sent = []; this.selfId = null }
  onEvent(h) { this.handlers.push(h); return () => {} }
  emit(raw) { for (const h of [...this.handlers]) h(raw) }
  sendPrivateMessage(userId, message) { this.sent.push({ target: 'private', id: userId, message }); return Promise.resolve({ message_id: this.sent.length }) }
  sendGroupMessage(groupId, message) { this.sent.push({ target: 'group', id: groupId, message }); return Promise.resolve({ message_id: this.sent.length }) }
}

/** 可编程 fake LLM：默认回显「收到：<最后一句>」。 */
class FakeLlm {
  constructor() { this.calls = []; this.replies = []; this.delayMs = 0; this.failWith = null; this.manual = null }
  async chatComplete({ messages }) {
    this.calls.push(messages)
    if (this.manual) return this.manual.promise
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.failWith) throw this.failWith
    const last = messages[messages.length - 1].content
    return { text: this.replies.shift() ?? `收到：${last}`, usage: null }
  }
}

function makeEngine(opts = {}) {
  const client = opts.client ?? new FakeClient()
  const llm = opts.llm ?? new FakeLlm()
  const sessions = new SessionStore({ shortTermTurns: 3 })
  const engine = new ChatEngine({
    client,
    llm,
    sessions,
    cfg: {
      persona: { name: '大肥鱼', prompt: '' },
      owner: { qq: 0, groups: [] },
      ...opts.cfg,
    },
    logger: quietLog,
    memory: opts.memory,
    hooks: opts.hooks,
  })
  engine.attach()
  return { client, llm, sessions, engine }
}

const privateMsg = (qq, text, extra = {}) => ({
  post_type: 'message', message_type: 'private', message_id: 1, user_id: qq,
  message: [{ type: 'text', data: { text } }], sender: { nickname: '主人' }, ...extra,
})

const groupMsg = (gid, qq, segments, extra = {}) => ({
  post_type: 'message', message_type: 'group', message_id: 2, user_id: qq, group_id: gid,
  message: segments, sender: { card: '群友' }, ...extra,
})

const waitSent = async (client, n, ms = 2000) => {
  const start = Date.now()
  while (client.sent.length < n) {
    if (Date.now() - start > ms) throw new Error(`等第 ${n} 条回复超时，实际 ${client.sent.length}`)
    await new Promise((r) => setTimeout(r, 10))
  }
  return client.sent
}

test('闭环：私聊消息 → 带人设和历史的模型请求 → 回复送达 → 历史更新', async (t) => {
  const { client, llm, sessions, engine } = makeEngine()
  client.emit(privateMsg(100, '你好'))
  await waitSent(client, 1)
  assert.equal(llm.calls.length, 1)
  const messages = llm.calls[0]
  assert.equal(messages[0].role, 'system')
  assert.ok(messages[0].content.includes('大肥鱼'), '系统提示词含人设')
  assert.deepEqual(messages.slice(1), [{ role: 'user', content: '你好' }])
  assert.equal(client.sent[0].target, 'private')
  assert.equal(client.sent[0].id, 100)
  assert.equal(client.sent[0].message, '收到：你好')
  // 第二轮带上历史
  client.emit(privateMsg(100, '在吗'))
  await waitSent(client, 2)
  assert.equal(llm.calls[1][1].content, '你好')
  assert.equal(llm.calls[1][2].role, 'assistant')
  assert.equal(llm.calls[1][3].content, '在吗')
  t.after(() => engine.dispose())
})

test('权限：主人模式下非主人私聊不回', async (t) => {
  const { client, llm, engine } = makeEngine({ cfg: { owner: { qq: 123, groups: [] } } })
  client.emit(privateMsg(999, '你好'))
  client.emit(privateMsg(123, '你好'))
  await waitSent(client, 1)
  assert.equal(llm.calls.length, 1, '只有主人的消息进模型')
  assert.equal(client.sent[0].id, 123)
  t.after(() => engine.dispose())
})

test('权限：群聊只有白名单群 + @鱼 或关键词才回', async (t) => {
  const { client, llm, engine } = makeEngine({ cfg: { owner: { qq: 0, groups: ['999'] } } })
  client.emit({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 111 })
  // 非白名单群
  client.emit(groupMsg(888, 100, [{ type: 'at', data: { qq: '111' } }, { type: 'text', data: { text: '在吗' } }]))
  // 白名单群但没 @ 没关键词
  client.emit(groupMsg(999, 100, [{ type: 'text', data: { text: '随便说说' } }]))
  // 白名单群 + @
  client.emit(groupMsg(999, 100, [{ type: 'at', data: { qq: '111' } }, { type: 'text', data: { text: '在吗' } }]))
  await waitSent(client, 1)
  assert.equal(llm.calls.length, 1)
  assert.equal(client.sent[0].target, 'group')
  assert.equal(client.sent[0].id, 999)
  // 白名单群 + 关键词
  client.emit(groupMsg(999, 100, [{ type: 'text', data: { text: '大肥鱼出来玩' } }]))
  await waitSent(client, 2)
  assert.equal(llm.calls.length, 2)
  t.after(() => engine.dispose())
})

test('命令：/帮助 /状态 /清空，命令不入会话历史', async (t) => {
  const memory = { async retrieve() { return '' }, remember() {}, async count() { return 7 } }
  const { client, llm, sessions, engine } = makeEngine({ memory })
  client.emit(privateMsg(100, '/帮助'))
  await waitSent(client, 1)
  assert.ok(client.sent[0].message.includes('/状态'))
  client.emit(privateMsg(100, '/状态'))
  await waitSent(client, 2)
  assert.ok(client.sent[1].message.includes('连着 NapCat'))
  assert.ok(client.sent[1].message.includes('长期记忆：7'))
  client.emit(privateMsg(100, '/清空'))
  await waitSent(client, 3)
  assert.equal(llm.calls.length, 0, '命令不应进模型')
  assert.equal(sessions.size, 0, '命令不应产生会话')
  t.after(() => engine.dispose())
})

test('并发忙：上一条没生成完，新消息只回「忙」文案不进模型', async (t) => {
  const llm = new FakeLlm()
  let release
  llm.manual = { promise: new Promise((r) => { release = r }) }
  const { client, engine } = makeEngine({ llm })
  client.emit(privateMsg(100, '第一句'))
  await new Promise((r) => setTimeout(r, 20))
  client.emit(privateMsg(100, '第二句'))
  await waitSent(client, 1, 2000)
  assert.equal(client.sent[0].message.includes('忙') || client.sent[0].message.includes('稍等'), true, '第二条应收到忙提示')
  release({ text: '回第一句', usage: null })
  await waitSent(client, 2, 2000)
  assert.equal(client.sent[1].message, '回第一句')
  assert.equal(llm.calls.length, 1)
  t.after(() => engine.dispose())
})

test('LLM 失败：软文案兜底，不给用户报错堆栈', async (t) => {
  const llm = new FakeLlm()
  llm.failWith = new LlmError('EBOT-LLM-HTTP-500', '炸了')
  const { client, engine } = makeEngine({ llm })
  client.emit(privateMsg(100, '你好'))
  await waitSent(client, 1)
  assert.ok(client.sent[0].message.includes('鱼鱼'), '应有鱼鱼的软文案')
  assert.ok(!client.sent[0].message.includes('500'), '不暴露错误码')
  t.after(() => engine.dispose())
})

test('超长回复按 4000 字分段发送', async (t) => {
  const llm = new FakeLlm()
  llm.replies = ['长'.repeat(9000)]
  const { client, engine } = makeEngine({ llm })
  client.emit(privateMsg(100, '来段长的'))
  await waitSent(client, 3, 3000)
  assert.ok(client.sent.every((s) => typeof s.message === 'string' && s.message.length <= 4000))
  t.after(() => engine.dispose())
})

test('splitLongText 在句子边界切分', () => {
  const text = '第一句。'.repeat(500)
  const parts = splitLongText(text, 200)
  assert.ok(parts.every((p) => p.length <= 200))
  assert.ok(parts.length > 1)
  assert.equal(parts.join('').length, text.length, '拼接后无损')
  assert.deepEqual(splitLongText('短文本', 4000), ['短文本'])
  assert.deepEqual(splitLongText('', 10), [''])
})

test('无文本消息（纯表情/图片）不进模型、不回复', async (t) => {
  const { client, llm, engine } = makeEngine()
  client.emit({ post_type: 'message', message_type: 'private', message_id: 3, user_id: 100, message: [{ type: 'face', data: { id: '178' } }], sender: {} })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(llm.calls.length, 0)
  assert.equal(client.sent.length, 0)
  t.after(() => engine.dispose())
})

test('hooks：表情包 hook 的结果以 image 段随回复发出', async (t) => {
  const hooks = { async sticker() { return 'base64://fish.png' } }
  const { client, engine } = makeEngine({ hooks })
  client.emit(privateMsg(100, '卖个萌'))
  await waitSent(client, 1)
  const sent = client.sent[0].message
  assert.ok(Array.isArray(sent), '带 image 的消息应是 CQ 段数组')
  assert.ok(sent.some((s) => s.type === 'image' && s.data.file === 'base64://fish.png'))
  assert.ok(sent.some((s) => s.type === 'text'))
  t.after(() => engine.dispose())
})

test('记忆接口：回复前检索、回复后回写', async (t) => {
  const calls = { retrieve: [], remember: [] }
  const memory = {
    async retrieve(text) { calls.retrieve.push(text); return '主人喜欢咖啡。' },
    remember(ex) { calls.remember.push(ex) },
    async count() { return 0 },
  }
  const { client, llm, engine } = makeEngine({ memory })
  client.emit(privateMsg(100, '今天喝什么'))
  await waitSent(client, 1)
  assert.equal(calls.retrieve[0], '今天喝什么')
  assert.ok(llm.calls[0][0].content.includes('主人喜欢咖啡。'), '记忆注入系统提示词')
  assert.deepEqual(calls.remember[0], { peerKey: 'private:100', userText: '今天喝什么', replyText: '收到：今天喝什么' })
  t.after(() => engine.dispose())
})

test('扩展命令：commands 表里的命令可用，未处理的回默认文案', async (t) => {
  const { client, llm, engine } = makeEngine({ cfg: { owner: { qq: 0, groups: [] } } })
  engine.commands['记住'] = async (_event, _peerKey, args) => {
    if (!args.length) return '鱼鱼要记住什么呀？'
    return `已记住：${args.join(' ')}`
  }
  client.emit(privateMsg(100, '/记住 主人的生日是6月1日'))
  await waitSent(client, 1)
  assert.equal(client.sent[0].message, '已记住：主人的生日是6月1日')
  client.emit(privateMsg(100, '/不存在'))
  await waitSent(client, 2)
  assert.ok(client.sent[1].message.includes('/帮助'))
  assert.equal(llm.calls.length, 0, '命令不进模型')
  t.after(() => engine.dispose())
})
