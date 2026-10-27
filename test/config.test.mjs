/**
 * test/config.test.mjs —— 配置模块测试
 * 覆盖：默认值合并、合法配置通过、各类非法输入（URL/时间窗/枚举/范围/条件依赖）
 * （AGENTS.md 测试原则 1/4/8：以用户目标为起点、显式建模、覆盖失败路径）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, resolveConfig, deepMerge, validateConfig } from '../lib/config.mjs'

test('只给部分配置时，其余字段用默认值补齐', () => {
  const { config, errors } = resolveConfig({ onebot: { url: 'ws://127.0.0.1:3100' } })
  assert.equal(errors.length, 0)
  assert.equal(config.onebot.url, 'ws://127.0.0.1:3100', '覆盖的字段生效')
  assert.equal(config.onebot.token, DEFAULT_CONFIG.onebot.token, '未覆盖字段用默认值')
  assert.equal(config.llm.model, DEFAULT_CONFIG.llm.model)
  assert.equal(config.persona.name, '大肥鱼')
  assert.deepEqual(config.proactive.topics, [])
})

test('空配置（{}）等于纯默认值且校验通过', () => {
  const { config, errors } = resolveConfig({})
  assert.equal(errors.length, 0)
  assert.deepEqual(config, DEFAULT_CONFIG)
})

test('合法全量配置校验通过', () => {
  const { errors } = resolveConfig({
    onebot: { url: 'wss://example.com:3001', token: 't', apiTimeoutMs: 5000, reconnectBaseMs: 1000, reconnectMaxMs: 5000 },
    owner: { qq: 123456, groups: ['987654321'] },
    llm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm', temperature: 1.2, maxTokens: 256, timeoutMs: 30000 },
    persona: { name: '肥鱼', prompt: '你是鱼' },
    memory: { shortTermTurns: 5, longTerm: false, maxFacts: 100, autoExtract: false, embedding: { baseUrl: 'b', apiKey: 'k', model: 'm', topK: 3, minScore: 0.2 } },
    voice: { sttEnabled: false, tts: { provider: 'openai', piper: { bin: '', model: '', voiceConfig: '' }, openai: { baseUrl: 'https://tts.example.com/v1', apiKey: 'sk-t', model: 'tts-1-hd', voice: 'shimmer', format: 'wav' } } },
    sticker: { enabled: false, dir: '/tmp/s' },
    proactive: { enabled: false, windowStart: '08:00', windowEnd: '22:30', minIntervalHours: 1, maxIntervalHours: 3, topics: ['吃了吗'] },
    bili: { enabled: true, mentionName: '某人', autoComment: false, notifyQq: true, reportToQq: 'full' },
    log: { level: 'debug', dir: '/tmp/l' },
  })
  assert.equal(errors.length, 0, JSON.stringify(errors))
})

test('非法 WebSocket 地址报错（http:// 或空）', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, onebot: { ...DEFAULT_CONFIG.onebot, url: 'http://127.0.0.1:3001' } })
    .some((e) => e.path === 'onebot.url'))
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, onebot: { ...DEFAULT_CONFIG.onebot, url: '' } })
    .some((e) => e.path === 'onebot.url'))
})

test('重连上限小于下限时报错', () => {
  const errs = validateConfig({ ...DEFAULT_CONFIG, onebot: { ...DEFAULT_CONFIG.onebot, reconnectBaseMs: 10000, reconnectMaxMs: 1000 } })
  assert.ok(errs.some((e) => e.path === 'onebot.reconnectMaxMs'))
})

test('非法时间窗报错（25:00 / 12:60 / 9:00 / 非字符串）', () => {
  for (const bad of ['25:00', '12:60', '9:00', 'abc']) {
    const errs = validateConfig({ ...DEFAULT_CONFIG, proactive: { ...DEFAULT_CONFIG.proactive, windowStart: bad } })
    assert.ok(errs.some((e) => e.path === 'proactive.windowStart'), `应拒绝 ${bad}`)
  }
})

test('时间窗起止相同报错（窗口为空）', () => {
  const errs = validateConfig({ ...DEFAULT_CONFIG, proactive: { ...DEFAULT_CONFIG.proactive, windowStart: '10:00', windowEnd: '10:00' } })
  assert.ok(errs.some((e) => e.path === 'proactive.windowEnd'))
})

test('最小间隔大于最大间隔报错', () => {
  const errs = validateConfig({ ...DEFAULT_CONFIG, proactive: { ...DEFAULT_CONFIG.proactive, minIntervalHours: 5, maxIntervalHours: 2 } })
  assert.ok(errs.some((e) => e.path === 'proactive.maxIntervalHours'))
})

test('非法枚举报错（tts.provider / reportToQq / log.level）', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, tts: { ...DEFAULT_CONFIG.voice.tts, provider: 'edge' } } })
    .some((e) => e.path === 'voice.tts.provider'))
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, bili: { ...DEFAULT_CONFIG.bili, reportToQq: '全部' } })
    .some((e) => e.path === 'bili.reportToQq'))
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, log: { ...DEFAULT_CONFIG.log, level: 'verbose' } })
    .some((e) => e.path === 'log.level'))
})

test('温度越界报错（>2 或 <0）', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, temperature: 2.5 } })
    .some((e) => e.path === 'llm.temperature'))
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, temperature: -0.1 } })
    .some((e) => e.path === 'llm.temperature'))
})

test('条件依赖：provider=piper 时必须有模型文件', () => {
  const errs = validateConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, tts: { ...DEFAULT_CONFIG.voice.tts, provider: 'piper' } } })
  assert.ok(errs.some((e) => e.path === 'voice.tts.piper.model'))
})

test('条件依赖：provider=openai 时必须有 baseUrl 和 apiKey', () => {
  const errs = validateConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, tts: { ...DEFAULT_CONFIG.voice.tts, provider: 'openai' } } })
  assert.ok(errs.some((e) => e.path === 'voice.tts.openai.baseUrl'))
  assert.ok(errs.some((e) => e.path === 'voice.tts.openai.apiKey'))
})

test('类型错误报错（maxTokens 传字符串、qq 传小数）', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, maxTokens: 'abc' } })
    .some((e) => e.path === 'llm.maxTokens'))
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, owner: { ...DEFAULT_CONFIG.owner, qq: 1.5 } })
    .some((e) => e.path === 'owner.qq'))
})

test('失败路径：字符串字段被填成数字时不崩溃，只报类型错误', () => {
  const { errors } = resolveConfig({ onebot: { url: 12345 }, llm: { apiKey: { nested: true } } })
  assert.ok(errors.some((e) => e.path === 'onebot.url'), 'url 应报类型/格式错误')
  assert.ok(errors.some((e) => e.path === 'llm.apiKey'), 'apiKey 应报类型错误')
})

test('deepMerge：嵌套对象递归合并，数组整体覆盖', () => {
  const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] })
  assert.deepEqual(merged, { a: { x: 1, y: 3 }, list: [9] })
})

test('字符串字段自动 trim（url/apiKey/model 等）', () => {
  const { config } = resolveConfig({ llm: { apiKey: '  sk-abc  ' }, onebot: { url: ' ws://x ' } })
  assert.equal(config.llm.apiKey, 'sk-abc')
  assert.equal(config.onebot.url, 'ws://x')
})
