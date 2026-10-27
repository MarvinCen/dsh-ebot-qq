/**
 * test/logger.test.mjs —— 日志模块测试
 * 覆盖：目录创建、级别过滤、分模块文件、格式、轮转（AGENTS.md 规则 13 / 测试原则 3/5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../lib/logger.mjs'
import { makeTempDir } from './helpers.mjs'

test('启动时创建日志目录并写入 info 行', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, consoleMirror: false })
  log.info('启动完成')
  assert.ok(existsSync(join(dir, 'app.log')), 'app.log 应已创建')
  const text = readFileSync(join(dir, 'app.log'), 'utf8')
  assert.match(text, /\[INFO\] \[app\] 启动完成/)
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, '行首应是 ISO 时间戳')
})

test('级别过滤：level=info 时 debug 不落盘，warn/error 落盘', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, level: 'info', consoleMirror: false })
  log.debug('看不见我')
  log.info('看得见 info')
  log.warn('看得见 warn')
  log.error('看得见 error')
  const text = readFileSync(join(dir, 'app.log'), 'utf8')
  assert.ok(!text.includes('看不见我'), 'debug 行不应出现')
  assert.match(text, /\[INFO\] \[app\] 看得见 info/)
  assert.match(text, /\[WARN\] \[app\] 看得见 warn/)
  assert.match(text, /\[ERROR\] \[app\] 看得见 error/)
})

test('level=error 时只落 error', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, level: 'error', consoleMirror: false })
  log.info('info 被过滤')
  log.error('error 保留')
  const text = readFileSync(join(dir, 'app.log'), 'utf8')
  assert.ok(!text.includes('info 被过滤'))
  assert.ok(text.includes('error 保留'))
})

test('分模块文件：child(category) 写各自文件，不混进 app.log', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, consoleMirror: false })
  log.child('chat').info('聊了一条')
  log.child('memory').error('记忆写坏了')
  assert.ok(existsSync(join(dir, 'chat.log')))
  assert.ok(existsSync(join(dir, 'memory.log')))
  assert.ok(!existsSync(join(dir, 'app.log')), '没写 app 就不该有 app.log')
  assert.match(readFileSync(join(dir, 'chat.log'), 'utf8'), /\[INFO\] \[chat\] 聊了一条/)
  assert.match(readFileSync(join(dir, 'memory.log'), 'utf8'), /\[ERROR\] \[memory\] 记忆写坏了/)
})

test('文件轮转：超过 maxBytes 滚成 .1，新文件接着写', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, maxBytes: 64, consoleMirror: false })
  log.info('第一行内容比较长，用来把文件顶过 64 字节阈值')
  log.info('第二行内容')
  const file = join(dir, 'app.log')
  assert.ok(existsSync(file + '.1'), '旧档 app.log.1 应存在')
  const old = readFileSync(file + '.1', 'utf8')
  assert.ok(old.includes('第一行'), '旧档里应有第一行')
  const fresh = readFileSync(file, 'utf8')
  assert.ok(fresh.includes('第二行'), '新文件里应有第二行')
  assert.ok(!fresh.includes('第一行'), '新文件里不应再有第一行')
})

test('多行消息折叠成单行，保证一条日志一行', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, consoleMirror: false })
  log.info('第一行\n第二行')
  const text = readFileSync(join(dir, 'app.log'), 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 1, '应只有一行')
  assert.ok(lines[0].includes('第一行 ↵ 第二行'))
})

test('对象消息走 JSON 序列化，而不是 [object Object]', (t) => {
  const dir = join(makeTempDir(t), 'logs')
  const log = createLogger({ dir, consoleMirror: false })
  log.info({ qq: 123, text: 'hi' })
  const text = readFileSync(join(dir, 'app.log'), 'utf8')
  assert.ok(text.includes('"qq":123'), '应包含 JSON 内容')
  assert.ok(!text.includes('[object Object]'))
})

test('失败路径：日志目录不可用（路径是文件）时不抛错，降级为仅控制台', (t) => {
  const tmp = makeTempDir(t)
  const dir = join(tmp, 'not-a-dir.log')
  writeFileSync(dir, '我是一个文件')
  const log = createLogger({ dir, consoleMirror: false })
  assert.doesNotThrow(() => log.info('降级日志'), '目录不可用时写日志不应抛错')
  assert.equal(existsSync(dir + '/app.log'), false, '不应在文件路径下建日志')
})
