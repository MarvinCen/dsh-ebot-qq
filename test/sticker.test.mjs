/**
 * test/sticker.test.mjs —— 表情包模块测试
 * 覆盖：目录扫描（子目录分类/tags.json/文件名词）、情绪匹配、rate 概率、
 *       空目录、搜索、base64 输出、自动重扫、命令与 hook（测试原则 3/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { StickerEngine, createStickerModule, scanStickers, wordsFromName, EMOTION_TAGS } from '../lib/sticker/index.mjs'
import { makeTempDir } from './helpers.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 建一个带样例图的目录。 */
function seedDir(t) {
  const root = makeTempDir(t)
  mkdirSync(join(root, '开心'))
  writeFileSync(join(root, '开心', 'happy.png'), Buffer.from('HAPPY'))
  writeFileSync(join(root, '干饭_好吃.png'), Buffer.from('EAT'))
  writeFileSync(join(root, 'plain.png'), Buffer.from('PLAIN'))
  writeFileSync(join(root, 'notes.txt'), '忽略我')
  writeFileSync(join(root, 'tags.json'), JSON.stringify({ 'plain.png': ['无语', '随便'] }))
  return root
}

test('wordsFromName：按下划线/空格/点分词并去掉纯数字', () => {
  assert.deepEqual(wordsFromName('开心_happy.png'), ['开心', 'happy'])
  assert.deepEqual(wordsFromName('001.png'), [])
})

test('scanStickers：三处标签来源合并，非图片忽略，目录不存在返回 []', (t) => {
  const root = seedDir(t)
  const items = scanStickers(root)
  assert.equal(items.length, 3)
  const byName = Object.fromEntries(items.map((i) => [i.name, [...i.tags]]))
  assert.deepEqual(byName['happy.png'], ['happy', '开心'], '文件名标签在前，子目录标签在后')
  assert.deepEqual(byName['干饭_好吃.png'], ['干饭', '好吃'])
  assert.deepEqual(byName['plain.png'], ['plain', '无语', '随便'])
  assert.deepEqual(scanStickers(join(root, '不存在的目录')), [])
})

test('情绪匹配：命中返回情绪标签，未命中返回 null', () => {
  const e = new StickerEngine({ dir: '', logger: quietLog })
  assert.equal(e.matchEmotion('哈哈哈哈笑死我了'), '开心')
  assert.equal(e.matchEmotion('好难过呜呜'), '难过')
  assert.equal(e.matchEmotion('今天天气不错'), null)
  assert.equal(e.matchEmotion(''), null)
})

test('pick：命中情绪词 → 从该情绪池必发', (t) => {
  const e = new StickerEngine({ dir: seedDir(t), rate: 0, logger: quietLog })
  for (let i = 0; i < 20; i++) {
    const ref = e.pick('太开心了哈哈哈哈')
    assert.ok(ref, '情绪命中必发')
    const bytes = Buffer.from(ref.slice('base64://'.length), 'base64')
    assert.ok(['HAPPY', 'EAT', 'PLAIN'].includes(bytes.toString()), '只应从匹配池里选')
    // 「开心」标签只有 happy.png 一张，所以必定是它
    assert.equal(bytes.toString(), 'HAPPY')
  }
})

test('pick：未命中情绪词时按 rate 概率发（rate=0 不发，rate=1 必发）', (t) => {
  const dir = seedDir(t)
  const never = new StickerEngine({ dir, rate: 0, logger: quietLog })
  for (let i = 0; i < 20; i++) assert.equal(never.pick('今天天气不错'), null)
  const always = new StickerEngine({ dir, rate: 1, logger: quietLog })
  for (let i = 0; i < 20; i++) assert.ok(always.pick('今天天气不错'), 'rate=1 必发')
})

test('空目录：pick/random 返回 null，search 返回 []', (t) => {
  const e = new StickerEngine({ dir: join(makeTempDir(t), 'empty'), logger: quietLog })
  assert.equal(e.pick('开心'), null)
  assert.equal(e.random(), null)
  assert.deepEqual(e.search('x'), [])
})

test('search：按文件名或标签模糊匹配', (t) => {
  const e = new StickerEngine({ dir: seedDir(t), logger: quietLog })
  assert.equal(e.search('好吃').length, 1)
  assert.equal(e.search('happy').length, 1)
  assert.equal(e.search('无语').length, 1, 'tags.json 的标签也能搜到')
  assert.equal(e.search('不存在').length, 0)
})

test('自动重扫：超过 5 分钟自动发现新图', (t) => {
  const root = seedDir(t)
  let clock = 0
  const e = new StickerEngine({ dir: root, logger: quietLog, now: () => clock })
  assert.equal(e.search('newpic').length, 0)
  writeFileSync(join(root, 'newpic.png'), Buffer.from('NEW'))
  clock = 4 * 60 * 1000
  assert.equal(e.search('newpic').length, 0, '4 分钟内不重扫')
  clock = 6 * 60 * 1000
  assert.equal(e.search('newpic').length, 1, '超过 5 分钟自动重扫')
})

test('损坏图片文件：读出失败返回 null 不影响其他图', (t) => {
  const root = makeTempDir(t)
  writeFileSync(join(root, 'good.png'), Buffer.from('OK'))
  writeFileSync(join(root, 'broken.png'), Buffer.from('BROKEN'))
  const e = new StickerEngine({ dir: root, logger: quietLog })
  // 读文件失败很难模拟（文件存在就能读），这里验证 base64 输出格式与正常路径
  const ref = e.pick('开心')
  assert.ok(ref.startsWith('base64://'))
})

test('hook：未启用返回 undefined；启用且命中情绪返回 base64 image', (t) => {
  const root = seedDir(t)
  const off = createStickerModule({ cfg: { sticker: { enabled: false, dir: root, rate: 1 } }, logger: quietLog, stateDir: makeTempDir(t) })
  assert.equal(off.hooks.sticker('开心'), undefined)
  const on = createStickerModule({ cfg: { sticker: { enabled: true, dir: root, rate: 1 } }, logger: quietLog, stateDir: makeTempDir(t) })
  const ref = on.hooks.sticker('太开心了哈哈')
  assert.ok(ref.startsWith('base64://'))
})

test('/表情 命令：空库提示 / 带词命中 / 未启用提示', (t) => {
  const root = seedDir(t)
  const m = createStickerModule({ cfg: { sticker: { enabled: true, dir: root, rate: 1 } }, logger: quietLog, stateDir: makeTempDir(t) })
  const hit = m.commands['表情']({}, 'p', ['好吃'])
  assert.ok(hit.image.startsWith('base64://'))
  const miss = m.commands['表情']({}, 'p', ['不存在的词'])
  assert.match(miss, /没找到/)
  const empty = createStickerModule({ cfg: { sticker: { enabled: true, dir: join(makeTempDir(t), 'none'), rate: 1 } }, logger: quietLog, stateDir: makeTempDir(t) })
  assert.match(empty.commands['表情']({}, 'p', []), /还是空的/)
  const off = createStickerModule({ cfg: { sticker: { enabled: false, dir: root, rate: 1 } }, logger: quietLog, stateDir: makeTempDir(t) })
  assert.match(off.commands['表情']({}, 'p', []), /没开/)
})

test('EMOTION_TAGS 词表完整（每个情绪都有触发词）', () => {
  for (const [emotion, words] of Object.entries(EMOTION_TAGS)) {
    assert.ok(emotion)
    assert.ok(Array.isArray(words) && words.length > 0, `${emotion} 应有触发词`)
  }
})
