/**
 * lib/bili/client.mjs —— 与 dsh-bili-scroll 的对接
 * ----------------------------------------------------------------------------
 * 两个对接面（都避开它自带的 HTTP 信任栅栏，因为栅栏只认浏览器会话）：
 *   1. 配置同步：通过 DSH 官方 `configEditor` 服务改 bili-scroll 的条目配置
 *      （mentionName = 评论里 @ 谁、autoComment = 自动评论开关）——热更新，不用重启；
 *   2. 报告读取：bili-scroll 每天把报告写到 `<DSH_HOME>/bili-duty/out/<日期>.md`，
 *      我们直接读文件（同一台机器、同一份家目录），轮询变化推 QQ 通知。
 */

/** 在 configEditor 的条目列表里找 bili-scroll 的条目。 */
export function findBiliEntry(configEditor) {
  const list = configEditor?.configuration?.() ?? []
  return list.find(({ entry }) => entry?.id === 'bili-scroll' || entry?.name === 'dsh-bili-scroll')?.entry
}

/**
 * 把 mentionName / autoComment 同步给 bili-scroll（带变化检测，避免每次启动都写）。
 * @param {object} opts { configEditor, mentionName, autoComment, stateFile, readJson, writeJson, logger }
 * @returns {ok, synced, error}
 */
export async function syncBiliConfig(opts) {
  try {
    const entry = findBiliEntry(opts.configEditor)
    if (!entry) {
      opts.logger?.warn?.('没找到 dsh-bili-scroll 的配置条目（插件没装？），跳过配置同步')
      return { ok: true, synced: false, missing: true }
    }
    const desired = {
      mentionName: String(opts.mentionName ?? '').trim(),
      autoComment: opts.autoComment === true,
    }
    if (!desired.mentionName) return { ok: true, synced: false, reason: '未配置 @ 昵称，不动 bili-scroll 的评论设置' }
    // 变化检测：与上次同步值一致就不写
    const prev = opts.readJson?.(opts.stateFile, {}) ?? {}
    if (prev.mentionName === desired.mentionName && prev.autoComment === desired.autoComment) {
      return { ok: true, synced: false, reason: '配置无变化' }
    }
    await opts.configEditor.edit(entry, (current = {}) => ({
      ...current,
      mentionName: desired.mentionName,
      autoComment: desired.autoComment,
    }))
    opts.writeJson?.(opts.stateFile, { ...prev, ...desired, syncedAt: Date.now() })
    opts.logger?.info?.(`已同步 B站 评论设置：@${desired.mentionName}，自动评论=${desired.autoComment}`)
    return { ok: true, synced: true }
  } catch (e) {
    opts.logger?.warn?.(`同步 B站 配置失败：${e?.message ?? e}`)
    return { ok: false, synced: false, error: String(e?.message ?? e) }
  }
}
