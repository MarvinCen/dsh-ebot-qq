/**
 * lib/proactive/topics.mjs —— 主动聊天话题生成
 * ----------------------------------------------------------------------------
 * 话题来源（按优先级）：
 *   1. 长期记忆里的最近事实 → 钩子句式（「主人喜欢美式」→「今天也喝了吗？」）；
 *   2. 内置话题池 + 用户自定义 topics 随机。
 * rng 可注入，确定性可测。
 */

/** 内置开场话题池（卖萌风，符合大肥鱼人设）。 */
export const DEFAULT_TOPICS = [
  '咕噜～主人主人，在忙吗？鱼鱼想你了',
  '今天过得怎么样呀？讲给鱼鱼听听嘛',
  '噗噜！鱼鱼刚从水里冒出来，主人想我没？',
  '吃了吗？鱼鱼有点饿了……（盯着你）',
  '鱼鱼发现一个秘密：主人已经很久没理鱼鱼了！',
  '今天有什么好玩的事吗？也讲给鱼鱼听听嘛',
  '咕噜噜……鱼鱼刚打了个盹，梦见主人了',
  '要不要听鱼鱼讲个冷笑话？',
  '主人主人！今天也要加油鸭，鱼鱼在缸里给你打气',
  '鱼鱼数了一下，今天主人笑了 0 次，现在轮到鱼鱼逗你笑了',
]

/** 记忆事实 → 钩子句式。返回 null 表示这条事实不适合做话题。 */
export function memoryHook(factText) {
  const f = String(factText ?? '').trim()
  if (!f) return null
  const subject = f.replace(/^主人/, '').trim()
  if (!subject) return null
  return `鱼鱼突然想起来：主人${subject}～今天也是这样吗？`
}

/**
 * 挑一个话题。
 * @param {object} opts { memoryFacts: string[], topics: string[], rng }
 */
export function pickTopic(opts) {
  const rng = opts.rng ?? Math.random
  const facts = (opts.memoryFacts ?? []).map(memoryHook).filter(Boolean)
  if (facts.length && rng() < 0.6) {
    return facts[Math.floor(rng() * facts.length)]
  }
  const pool = [...DEFAULT_TOPICS, ...(opts.topics ?? [])]
  if (!pool.length) return '主人，鱼鱼在～'
  return pool[Math.floor(rng() * pool.length)]
}
