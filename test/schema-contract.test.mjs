/**
 * test/schema-contract.test.mjs —— 跨模块契约测试（AGENTS.md 测试原则 6）
 * ----------------------------------------------------------------------------
 * index.js 里导出的 Config（schemastery，给设置页用）和 lib/config.mjs 里的
 * DEFAULT_CONFIG（运行期生效）是同一个配置的两份描述。这份测试保证：
 *   1. Config({}) 用默认值实例化出来的对象 === DEFAULT_CONFIG（key 和默认值完全一致）；
 *   2. Config 对非法输入会拒绝（设置页和运行期不会各说各话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../lib/config.mjs'
import { Config } from '../index.js'

/**
 * 解开 schemastery volatile 字段的包装（与 dsh-settings 的 plainConfig 同理）：
 * volatile 叶子实例化后是 { Symbol(cosmokit.volatile.write), get() } 的访问器对象。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function plain(v) {
  if (v && typeof v === 'object') {
    if (VOLATILE_WRITE in v) return plain(v.get())
    const out = Array.isArray(v) ? [] : {}
    for (const k of Object.keys(v)) out[k] = plain(v[k])
    return out
  }
  return v
}

test('契约：schema 默认值实例 === DEFAULT_CONFIG', () => {
  assert.ok(Config, 'schemastery 可用时 Config 必须导出（否则设置页降级未被测试覆盖）')
  assert.deepEqual(plain(Config({})), DEFAULT_CONFIG)
})

test('契约：schema 管类型和默认值，严格校验在 config.mjs（分层设计）', () => {
  // 设计分层：schema 只约束类型，避免用户填坏一个值导致整条 entry 被 cordis 拒收
  // （bili-scroll 的教训）；格式/范围/条件依赖等严格校验统一在 validateConfig 里做。
  assert.doesNotThrow(() => Config({ onebot: { url: 'http://bad' } }), '格式问题交给运行期校验，schema 不拦')
  assert.throws(() => Config({ llm: { maxTokens: {} } }), '类型错误仍应被 schema 拒绝')
})
