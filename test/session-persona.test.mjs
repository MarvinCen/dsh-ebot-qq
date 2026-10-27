/**
 * test/session-persona.test.mjs —— 会话窗口 + 人设组装测试
 * 覆盖：历史顺序、轮数裁剪、多会话隔离、清空、容量淘汰、超长截断、
 *       默认/自定义人设、记忆注入、名字注入（测试原则 3/4：验证状态与数据变化）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../lib/chat/session.mjs'
import { buildSystemPrompt, DEFAULT_PERSONA_PROMPT } from '../lib/chat/persona.mjs'

test('历史按时间顺序记录', () => {
  const s = new SessionStore()
  const key = SessionStore.privateKey(123)
  s.push(key, 'user', '第一句')
  s.push(key, 'assistant', '第二句')
  assert.deepEqual(s.history(key), [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '第二句' },
  ])
})

test('轮数裁剪：只保留最近 shortTermTurns 轮', () => {
  const s = new SessionStore({ shortTermTurns: 2 })
  const key = SessionStore.privateKey(123)
  for (let i = 1; i <= 4; i++) {
    s.push(key, 'user', `问${i}`)
    s.push(key, 'assistant', `答${i}`)
  }
  const h = s.history(key)
  assert.equal(h.length, 4, '2 轮 = 4 条')
  assert.deepEqual(h.map((m) => m.content), ['问3', '答3', '问4', '答4'])
})

test('多会话隔离：私聊与群聊、不同 QQ 号互不串味', () => {
  const s = new SessionStore()
  s.push(SessionStore.privateKey(1), 'user', 'a')
  s.push(SessionStore.privateKey(2), 'user', 'b')
  s.push(SessionStore.groupKey(99), 'user', 'c')
  assert.equal(s.history(SessionStore.privateKey(1))[0].content, 'a')
  assert.equal(s.history(SessionStore.privateKey(2))[0].content, 'b')
  assert.equal(s.history(SessionStore.groupKey(99))[0].content, 'c')
})

test('清空会话与容量淘汰', () => {
  const s = new SessionStore({ maxPeers: 2 })
  const k1 = SessionStore.privateKey(1)
  const k2 = SessionStore.privateKey(2)
  const k3 = SessionStore.privateKey(3)
  s.push(k1, 'user', '1')
  s.push(k2, 'user', '2')
  s.push(k3, 'user', '3')
  assert.equal(s.size, 2, '超容量后淘汰最老的')
  assert.equal(s.history(k1).length, 0, 'k1 被淘汰')
  s.clear(k2)
  assert.equal(s.history(k2).length, 0)
  assert.equal(s.size, 1)
})

test('超长单条消息截断到上限，空消息不入', () => {
  const s = new SessionStore()
  const key = SessionStore.privateKey(1)
  s.push(key, 'user', 'x'.repeat(9000))
  assert.equal(s.history(key)[0].content.length, 4000)
  s.push(key, 'user', '   ')
  assert.equal(s.history(key).length, 1, '纯空白不入库')
})

test('默认人设：包含名字与自称', () => {
  const p = buildSystemPrompt({ name: '大肥鱼' })
  assert.ok(p.includes('大肥鱼'), '默认人设应包含名字')
  assert.ok(p.includes('鱼鱼'), '应包含自称')
  assert.ok(p.includes('今天'), '应包含日期')
  assert.equal(DEFAULT_PERSONA_PROMPT.length > 100, true)
})

test('自定义人设整体替换默认', () => {
  const p = buildSystemPrompt({ name: '大肥鱼', prompt: '你是严肃的鱼。' })
  assert.ok(p.startsWith('你是严肃的鱼。'))
  assert.ok(!p.includes('贪吃'), '不应混入默认人设内容')
})

test('记忆注入：检索文本会出现在系统提示词里', () => {
  const p = buildSystemPrompt({ name: '大肥鱼', memoryText: '主人喜欢喝美式。' })
  assert.ok(p.includes('主人喜欢喝美式。'))
  assert.ok(p.includes('不要逐条复述'), '注入格式应包含使用引导')
})

test('自定义名字被注入', () => {
  const p = buildSystemPrompt({ name: '肥仔', prompt: '你是一条鱼' })
  assert.ok(p.includes('肥仔'), '名字应被注入')
})
