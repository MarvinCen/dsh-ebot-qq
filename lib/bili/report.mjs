/**
 * lib/bili/report.mjs —— bili-scroll 日报的读取与摘要
 * ----------------------------------------------------------------------------
 * 报告格式约定（bili-scroll README）：每条以 `### BV号` 开头，含「**标题**：…」。
 * 我们只依赖这个约定做摘要，不解析全部 Markdown。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'

/** 今天的报告路径。stateDir = bili-scroll 的家目录（<DSH_HOME>/bili-duty）。 */
export function reportPath(stateDir, day) {
  return `${stateDir}/out/${day}.md`
}

/** 读报告：不存在返回 { exists:false }。 */
export function readReport(file) {
  try {
    if (!existsSync(file)) return { exists: false, text: '', mtimeMs: 0 }
    return { exists: true, text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }
  } catch {
    return { exists: false, text: '', mtimeMs: 0 }
  }
}

/** 内容签名（变化检测用）：长度 + 首尾摘要，轻量且稳定。 */
export function signature(text) {
  const src = String(text ?? '')
  if (!src) return ''
  const head = src.slice(0, 200)
  const tail = src.slice(-100)
  return `${src.length}:${head}:${tail}`
}

/**
 * 从报告全文提取摘要条目。
 * 每条格式：`### BV1xxxxxxx` 行开始到下一个 `###` 前为一块；
 * 标题优先取「**标题**：xxx」，没有就取块内第一行文本。
 * @returns Array<{ bv, title, url }>
 */
export function extractSummary(text) {
  const src = String(text ?? '')
  const blocks = src.split(/\n(?=###\s*BV[0-9A-Za-z]{10})/)
  const items = []
  for (const block of blocks) {
    const head = /^###\s*(BV[0-9A-Za-z]{10})/.exec(block.trim())
    if (!head) continue
    const bv = head[1]
    const titleMatch = /\*\*标题\*\*\s*[：:]\s*(.+)/.exec(block)
    const bodyLines = block.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
    const title = (titleMatch?.[1] ?? bodyLines[0] ?? '').replace(/[*#|]/g, '').trim() || bv
    items.push({ bv, title: title.slice(0, 60), url: `https://www.bilibili.com/video/${bv}` })
  }
  return items
}

/** 摘要 → 给主人看的通知文本。 */
export function formatNotification(items, personaName = '大肥鱼') {
  if (!items.length) return `咕噜～${personaName}今天的 B站 日报是空的，什么都没挑中。`
  const lines = [`咕噜～${personaName}今天刷 B站「空友爱看」的战报（${items.length} 条）：`]
  for (const item of items.slice(0, 8)) lines.push(`· ${item.title}\n  ${item.url}`)
  if (items.length > 8) lines.push(`……还有 ${items.length - 8} 条，看今天的报告文件吧`)
  return lines.join('\n')
}
