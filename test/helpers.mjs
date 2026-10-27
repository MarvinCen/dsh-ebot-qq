/**
 * test/helpers.mjs —— 测试公共小工具
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 建一个临时目录，测试结束自动删除（挂在 t.after 上）。 */
export function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ebot-qq-test-'))
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
  })
  return dir
}
