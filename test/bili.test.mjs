/**
 * test/bili.test.mjs —— B站 集成模块测试
 * 覆盖：configEditor 条目查找与配置同步（变化检测/缺条目/失败）、
 *       报告读取与摘要解析、签名变化检测、轮询通知各状态（测试原则 3/5/6/8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { findBiliEntry, syncBiliConfig } from '../lib/bili/client.mjs'
import { reportPath, readReport, signature, extractSummary, formatNotification } from '../lib/bili/report.mjs'
import { BiliModule } from '../lib/bili/index.mjs'
import { makeTempDir } from './helpers.mjs'

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

const SAMPLE_REPORT = [
  '# 刷B站 · 2026-10-27 日报',
  '',
  '### BV1xx411c7mD',
  '',
  '**标题**：DeepSeek 出了个新玩具',
  '**为什么值得**：演示很炸',
  '',
  '### BV1yy411c7mE',
  '',
  '标题行没有加粗',
  '',
].join('\n')

test('findBiliEntry：按 id 或 name 找到 bili-scroll 条目', () => {
  const fakeEditor = {
    configuration: () => [
      { entry: { id: 'other', name: 'x' } },
      { entry: { id: 'bili-scroll', name: 'dsh-bili-scroll' } },
    ],
  }
  assert.equal(findBiliEntry(fakeEditor)?.id, 'bili-scroll')
  assert.equal(findBiliEntry({ configuration: () => [] }), undefined)
  assert.equal(findBiliEntry(null), undefined)
})

test('syncBiliConfig：条目缺失时跳过并报告 missing', async (t) => {
  const dir = makeTempDir(t)
  const r = await syncBiliConfig({
    configEditor: { configuration: () => [] },
    mentionName: '某人',
    autoComment: true,
    stateFile: join(dir, 'sync.json'),
    logger: quietLog,
  })
  assert.equal(r.ok, true)
  assert.equal(r.missing, true)
})

test('syncBiliConfig：mentionName 为空不写配置', async (t) => {
  const dir = makeTempDir(t)
  let editCalls = 0
  const r = await syncBiliConfig({
    configEditor: {
      configuration: () => [{ entry: { id: 'bili-scroll' } }],
      edit: () => { editCalls++ },
    },
    mentionName: '',
    autoComment: true,
    stateFile: join(dir, 'sync.json'),
    logger: quietLog,
  })
  assert.equal(editCalls, 0)
  assert.equal(r.synced, false)
})

test('syncBiliConfig：首次同步写入，重复同步被变化检测挡住', async (t) => {
  const dir = makeTempDir(t)
  const stateFile = join(dir, 'sync.json')
  const edits = []
  const editor = {
    configuration: () => [{ entry: { id: 'bili-scroll' } }],
    edit: async (entry, change) => { edits.push(change({})) },
  }
  const opts = {
    configEditor: editor,
    mentionName: '某人',
    autoComment: true,
    stateFile,
    readJson: (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return fb } },
    writeJson: (f, v) => writeFileSync(f, JSON.stringify(v), 'utf8'),
    logger: quietLog,
  }
  const first = await syncBiliConfig(opts)
  assert.equal(first.synced, true)
  assert.equal(edits.length, 1)
  assert.deepEqual(edits[0], { mentionName: '某人', autoComment: true })
  const second = await syncBiliConfig(opts)
  assert.equal(second.synced, false, '第二次应被变化检测挡住')
  assert.equal(edits.length, 1)
})

test('syncBiliConfig：edit 抛错返回 ok:false 不炸', async (t) => {
  const dir = makeTempDir(t)
  const r = await syncBiliConfig({
    configEditor: {
      configuration: () => [{ entry: { id: 'bili-scroll' } }],
      edit: () => { throw new Error('写不动') },
    },
    mentionName: '某人',
    autoComment: true,
    stateFile: join(dir, 'sync.json'),
    logger: quietLog,
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /写不动/)
})

test('reportPath / readReport：存在与不存在', (t) => {
  const dir = makeTempDir(t)
  const file = reportPath(dir, '2026-10-27')
  assert.equal(readReport(file).exists, false)
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(file, 'hello', 'utf8')
  const r = readReport(file)
  assert.equal(r.exists, true)
  assert.equal(r.text, 'hello')
  assert.ok(r.mtimeMs > 0)
})

test('signature：内容变化则签名变化，空内容为空串', () => {
  assert.notEqual(signature('abc'), signature('abd'))
  assert.equal(signature(''), '')
  assert.equal(signature('x'), signature('x'), '同内容签名稳定')
})

test('extractSummary：按 ### BV 块解析标题与链接', () => {
  const items = extractSummary(SAMPLE_REPORT)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { bv: 'BV1xx411c7mD', title: 'DeepSeek 出了个新玩具', url: 'https://www.bilibili.com/video/BV1xx411c7mD' })
  assert.deepEqual(items[1], { bv: 'BV1yy411c7mE', title: '标题行没有加粗', url: 'https://www.bilibili.com/video/BV1yy411c7mE' })
  assert.deepEqual(extractSummary('没有 BV 的文本'), [])
  assert.deepEqual(extractSummary(''), [])
})

test('formatNotification：空与有内容', () => {
  assert.match(formatNotification([]), /空的/)
  const text = formatNotification([{ bv: 'BV1xx411c7mD', title: '标题', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }])
  assert.ok(text.includes('BV1xx411c7mD'))
  assert.ok(text.includes('标题'))
})

function makeBili(t, opts = {}) {
  const dir = makeTempDir(t)
  const stateDir = join(dir, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  const sent = []
  const mod = new BiliModule({
    cfg: { enabled: true, mentionName: '某人', autoComment: true, notifyQq: true, reportToQq: 'summary', ...opts.cfg },
    configEditor: opts.configEditor,
    stateDir,
    syncFile: join(dir, 'ebot-qq', 'bili-sync.json'),
    lastReportFile: join(dir, 'ebot-qq', 'bili-last-report.json'),
    notify: (text) => { sent.push(text); return Promise.resolve() },
    logger: quietLog,
    pollMinutes: opts.pollMinutes ?? 5,
    dayKey: opts.dayKey ?? (() => '2026-10-27'),
    now: () => 0,
  })
  t.after(() => mod.dispose())
  return { mod, sent, dir, stateDir }
}

test('pollNow：报告出现即通知，重复轮询不重复通知', async (t) => {
  const { mod, sent, stateDir } = makeBili(t)
  assert.deepEqual(await mod.pollNow(), { notified: false, exists: false })
  writeFileSync(reportPath(stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  const first = await mod.pollNow()
  assert.equal(first.notified, true)
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('BV1xx411c7mD'))
  const second = await mod.pollNow()
  assert.equal(second.notified, false)
  assert.equal(second.unchanged, true, '内容没变不重复通知')
  assert.equal(sent.length, 1)
})

test('pollNow：报告追加新内容（mtime 变化）会再次通知', async (t) => {
  const { mod, sent, stateDir } = makeBili(t)
  writeFileSync(reportPath(stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  await mod.pollNow()
  writeFileSync(reportPath(stateDir, '2026-10-27'), SAMPLE_REPORT + '\n### BV1zz411c7mF\n\n新的一条\n', 'utf8')
  const r = await mod.pollNow()
  assert.equal(r.notified, true)
  assert.equal(sent.length, 2)
  assert.ok(sent[1].includes('BV1zz411c7mF'))
})

test('pollNow：enabled=false / notifyQq=false / reportToQq=off 都不通知', async (t) => {
  const off = makeBili(t, { cfg: { enabled: false } })
  writeFileSync(reportPath(off.stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  assert.deepEqual(await off.mod.pollNow(), { notified: false })
  const noNotify = makeBili(t, { cfg: { notifyQq: false } })
  writeFileSync(reportPath(noNotify.stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  assert.deepEqual(await noNotify.mod.pollNow(), { notified: false })
  const silent = makeBili(t, { cfg: { reportToQq: 'off' } })
  writeFileSync(reportPath(silent.stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  assert.deepEqual(await silent.mod.pollNow(), { notified: false })
})

test('pollNow：reportToQq=full 发整份报告', async (t) => {
  const { mod, sent, stateDir } = makeBili(t, { cfg: { reportToQq: 'full' } })
  writeFileSync(reportPath(stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  await mod.pollNow()
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('为什么值得'), 'full 模式包含报告正文')
})

test('syncNow：enabled=false 时不同步', async (t) => {
  let editCalls = 0
  const { mod } = makeBili(t, {
    cfg: { enabled: false },
    configEditor: { configuration: () => [{ entry: { id: 'bili-scroll' } }], edit: () => { editCalls++ } },
  })
  const r = await mod.syncNow()
  assert.equal(r.synced, false)
  assert.equal(editCalls, 0)
})

test('start/dispose：定时器生命周期，dispose 后不再轮询', async (t) => {
  const { mod, sent, stateDir } = makeBili(t, { pollMinutes: 1 })
  mod.start()
  assert.notEqual(mod._timer, null)
  writeFileSync(reportPath(stateDir, '2026-10-27'), SAMPLE_REPORT, 'utf8')
  await mod.pollNow() // 立即触发一次（不等 1 分钟）
  assert.equal(sent.length, 1)
  mod.dispose()
  assert.equal(mod._timer, null)
})
