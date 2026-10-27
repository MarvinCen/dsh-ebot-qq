/**
 * test/memory-extract.test.mjs —— 记忆提取（LLM 输出解析）测试
 * 覆盖：正常 JSON、带围栏、带杂字、坏 JSON、空输出、非数组（失败路径全收）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFacts, extractFacts } from '../lib/memory/extract.mjs'

test('解析标准 JSON 数组', () => {
  const facts = parseFacts('[{"text":"主人喜欢喝美式","kind":"preference"},{"text":"主人养猫","kind":"fact"}]')
  assert.equal(facts.length, 2)
  assert.deepEqual(facts[0], { text: '主人喜欢喝美式', kind: 'preference' })
  assert.deepEqual(facts[1], { text: '主人养猫', kind: 'fact' })
})

test('解析带 ```json 围栏的输出', () => {
  const facts = parseFacts('好的，以下是结果：\n```json\n[{"text":"主人每天六点起床"}]\n```\n')
  assert.deepEqual(facts, [{ text: '主人每天六点起床', kind: 'fact' }])
})

test('未知 kind 归一为 fact；空文本条目被丢弃', () => {
  const facts = parseFacts('[{"text":"a","kind":"爱好"},{"text":""},{"text":"b"}]')
  assert.deepEqual(facts.map((f) => f.text), ['a', 'b'])
  assert.equal(facts[0].kind, 'fact')
})

test('失败路径：坏 JSON / 非数组 / 空字符串都返回 []', () => {
  assert.deepEqual(parseFacts('这不是 JSON'), [])
  assert.deepEqual(parseFacts('{"a":1}'), [])
  assert.deepEqual(parseFacts(''), [])
  assert.deepEqual(parseFacts('[]'), [])
})

test('extractFacts：模型输出正常时提取成功', async () => {
  const llm = { chatComplete: async () => ({ text: '[{"text":"主人喜欢辣椒","kind":"preference"}]' }) }
  const facts = await extractFacts(llm, { userText: '我爱吃辣', replyText: '好嘞' }, {})
  assert.deepEqual(facts, [{ text: '主人喜欢辣椒', kind: 'preference' }])
})

test('extractFacts：模型抛错时返回 [] 且不抛异常', async () => {
  const llm = { chatComplete: async () => { throw new Error('模型炸了') } }
  const facts = await extractFacts(llm, { userText: 'x', replyText: 'y' }, {})
  assert.deepEqual(facts, [])
})
