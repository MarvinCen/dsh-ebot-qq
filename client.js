/**
 * dsh-ebot-qq —— 浏览器半端（「设置 → 插件 → 大肥鱼」一页）
 * ============================================================================
 * 注册约定（与官方 decoration 模板 / bili-scroll 一致）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })
 * 面板挂进官方「设置 → 插件」分区的 tab 插槽 `settings.plugins.tab`。
 *
 * 数据走宿主路由 /api/ebot-qq/config（读 = settings.describe 纯值 + secret 状态；
 * 写 = settings.update 热更新，400/409 都有对应提示）。
 * 风格：全部使用设置页同款 CSS 变量（--dsw-*），布局 flex/grid（AGENTS.md 规则 6）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-ebot-qq',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const API = '/api/ebot-qq'

    const asJson = async (res) => {
      const data = await res.json().catch(() => ({}))
      if (res.ok) return data
      const err = new Error(data?.error || `HTTP ${res.status}`)
      err.data = data
      err.status = res.status
      throw err
    }
    const jget = () => fetch(`${API}/config`, { credentials: 'same-origin' }).then(asJson)
    const jpost = (patch) => fetch(`${API}/config`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    }).then(asJson)

    // ───────────────────────── 表单结构（分组 → 字段） ─────────────────────────
    const GROUPS = [
      { key: 'onebot', title: 'OneBot（QQ 连接）', fields: [
        { k: ['onebot', 'url'], type: 'text', label: 'NapCat WebSocket 地址', note: 'NapCat WebUi「网络配置」里开启 WebSocket 服务器后的地址' },
        { k: ['onebot', 'token'], type: 'secret', label: 'access_token', note: 'NapCat 设了才填；留空 = 不改' },
        { k: ['onebot', 'apiTimeoutMs'], type: 'number', label: 'API 超时（毫秒）' },
        { k: ['onebot', 'reconnectBaseMs'], type: 'number', label: '重连起始间隔（毫秒）' },
        { k: ['onebot', 'reconnectMaxMs'], type: 'number', label: '重连最大间隔（毫秒）' },
      ] },
      { key: 'owner', title: '主人与群', fields: [
        { k: ['owner', 'qq'], type: 'number', label: '主人的 QQ 号', note: '0 = 谁都能聊；填了只回主人' },
        { k: ['owner', 'groups'], type: 'textlist', label: '允许响应的群号', note: '一行一个；空 = 不响应群' },
      ] },
      { key: 'llm', title: 'LLM（大肥鱼的脑子）', fields: [
        { k: ['llm', 'baseUrl'], type: 'text', label: 'API 地址', note: 'OpenAI 兼容，如 https://api.deepseek.com/v1' },
        { k: ['llm', 'apiKey'], type: 'secret', label: 'API Key', note: '留空 = 不改' },
        { k: ['llm', 'model'], type: 'text', label: '模型名', note: '如 deepseek-chat' },
        { k: ['llm', 'temperature'], type: 'number', label: 'temperature（0~2）' },
        { k: ['llm', 'maxTokens'], type: 'number', label: '回复最大 token' },
      ] },
      { key: 'persona', title: '人设', fields: [
        { k: ['persona', 'name'], type: 'text', label: '名字' },
        { k: ['persona', 'prompt'], type: 'textarea', label: '自定义人设', note: '留空 = 使用内置「大肥鱼」人设' },
      ] },
      { key: 'memory', title: '记忆', fields: [
        { k: ['memory', 'shortTermTurns'], type: 'number', label: '短期记忆轮数' },
        { k: ['memory', 'longTerm'], type: 'boolean', label: '长期记忆' },
        { k: ['memory', 'autoExtract'], type: 'boolean', label: '自动提取记忆', note: '每 10 轮对话自动提取一次事实' },
        { k: ['memory', 'embedding', 'baseUrl'], type: 'text', label: 'Embedding 地址', note: '三件套配齐才启用向量检索' },
        { k: ['memory', 'embedding', 'apiKey'], type: 'secret', label: 'Embedding API Key' },
        { k: ['memory', 'embedding', 'model'], type: 'text', label: 'Embedding 模型' },
      ] },
      { key: 'voice', title: '语音', fields: [
        { k: ['voice', 'sttEnabled'], type: 'boolean', label: '听懂语音（转写）' },
        { k: ['voice', 'mode'], type: 'select', label: '回复带语音', options: [['off', '不发'], ['on', '每条都发'], ['smart', '短回复（≤80字）才发']] },
        { k: ['voice', 'tts', 'provider'], type: 'select', label: 'TTS 引擎', options: [['off', '关'], ['piper', 'Piper（本地，需下载模型）'], ['openai', 'OpenAI 兼容（云端）']] },
        { k: ['voice', 'tts', 'piper', 'bin'], type: 'text', label: 'Piper 可执行文件路径', note: '下载：github.com/rhasspy/piper/releases' },
        { k: ['voice', 'tts', 'piper', 'model'], type: 'text', label: 'Piper 模型 .onnx 路径', note: '如 zh_CN-huayan-medium' },
        { k: ['voice', 'tts', 'openai', 'baseUrl'], type: 'text', label: '云端 TTS 地址', note: '如 https://api.openai.com/v1' },
        { k: ['voice', 'tts', 'openai', 'apiKey'], type: 'secret', label: '云端 TTS Key' },
        { k: ['voice', 'tts', 'openai', 'model'], type: 'text', label: 'TTS 模型', note: '如 tts-1' },
        { k: ['voice', 'tts', 'openai', 'voice'], type: 'text', label: '音色', note: '如 alloy / shimmer' },
      ] },
      { key: 'sticker', title: '表情包', fields: [
        { k: ['sticker', 'enabled'], type: 'boolean', label: '启用表情包' },
        { k: ['sticker', 'dir'], type: 'text', label: '表情包目录', note: '留空 = 插件家目录 stickers/；按情绪建子文件夹效果最好' },
        { k: ['sticker', 'rate'], type: 'number', label: '随机发送概率（0~1）', note: '命中情绪词必发，不受此限制' },
      ] },
      { key: 'proactive', title: '主动聊天', fields: [
        { k: ['proactive', 'enabled'], type: 'boolean', label: '启用主动聊天' },
        { k: ['proactive', 'windowStart'], type: 'text', label: '时间窗开始（HH:mm）' },
        { k: ['proactive', 'windowEnd'], type: 'text', label: '时间窗结束（HH:mm）', note: '支持跨夜，如 22:00 – 02:00' },
        { k: ['proactive', 'minIntervalHours'], type: 'number', label: '最小间隔（小时）' },
        { k: ['proactive', 'maxIntervalHours'], type: 'number', label: '最大间隔（小时）' },
        { k: ['proactive', 'cooldownMinutes'], type: 'number', label: '聊天后冷却（分钟）', note: '刚聊完这段时间内不主动打扰' },
        { k: ['proactive', 'topics'], type: 'textlist', label: '补充话题', note: '一行一个' },
      ] },
      { key: 'bili', title: 'B站 联动', fields: [
        { k: ['bili', 'enabled'], type: 'boolean', label: '启用 B站 联动' },
        { k: ['bili', 'mentionName'], type: 'text', label: '评论里 @ 的 B站昵称', note: '刷空友爱看时在评论区 @ 这个人；空 = 只通知不 @' },
        { k: ['bili', 'autoComment'], type: 'boolean', label: '自动评论', note: '会用你扫码登录的 B站 号发评论并 @ 上面的人' },
        { k: ['bili', 'notifyQq'], type: 'boolean', label: '刷完通知 QQ' },
        { k: ['bili', 'reportToQq'], type: 'select', label: '通知形态', options: [['summary', '摘要'], ['full', '全文'], ['off', '不通知']] },
        { k: ['bili', 'pollMinutes'], type: 'number', label: '轮询间隔（分钟）' },
      ] },
      { key: 'log', title: '日志', fields: [
        { k: ['log', 'level'], type: 'select', label: '日志级别', options: [['debug', 'debug'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']] },
        { k: ['log', 'dir'], type: 'text', label: '日志目录', note: '留空 = 插件家目录 logs/' },
      ] },
    ]

    // ───────────────────────── 小工具 ─────────────────────────
    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj)
    const setPath = (obj, path, v) => {
      const out = Array.isArray(obj) ? [...obj] : { ...obj }
      let cur = out
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i]
        const next = cur[key] == null || typeof cur[key] !== 'object' ? {} : cur[key]
        cur[key] = next
        cur = next
      }
      cur[path[path.length - 1]] = v
      return out
    }

    const CSS = `
[data-ebot-page]{display:flex;flex-direction:column;gap:20px;max-width:680px;padding:2px 2px 10px;}
[data-ebot-sec]{display:flex;flex-direction:column;gap:10px;}
[data-ebot-h]{font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#9aa0a6);text-transform:none;}
[data-ebot-row]{display:grid;grid-template-columns:minmax(150px,220px) 1fr;gap:10px;align-items:start;}
[data-ebot-label]{font-size:13px;line-height:30px;color:var(--dsw-alias-label,#2b3038);}
[data-ebot-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:4px;}
[data-ebot-ctrl]{width:100%;}
[data-ebot-ctrl] input[type=text],[data-ebot-ctrl] input[type=number],[data-ebot-ctrl] textarea,[data-ebot-ctrl] select{
  width:100%;box-sizing:border-box;padding:6px 9px;font-size:13px;border-radius:8px;
  border:1px solid var(--dsw-alias-border,#dfe3e8);background:var(--dsw-alias-bg-float,#fff);color:var(--dsw-alias-label,#2b3038);
  font-family:inherit;outline:none;
}
[data-ebot-ctrl] input:focus,[data-ebot-ctrl] textarea:focus,[data-ebot-ctrl] select:focus{border-color:var(--dsw-brand-600,#247bbf);}
[data-ebot-ctrl] textarea{min-height:64px;resize:vertical;}
[data-ebot-err]{font-size:11px;color:var(--dsw-red,#d93025);margin-top:4px;}
[data-ebot-foot]{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
[data-ebot-btn]{padding:7px 18px;font-size:13px;border-radius:8px;border:0;cursor:pointer;color:#fff;background:var(--dsw-brand-600,#247bbf);}
[data-ebot-btn]:disabled{opacity:.55;cursor:default;}
[data-ebot-msg-ok]{font-size:12px;color:var(--dsw-green,#1a7f37);}
[data-ebot-msg-bad]{font-size:12px;color:var(--dsw-red,#d93025);}
[data-ebot-top-note]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5f6672);}
@media (max-width:560px){[data-ebot-row]{grid-template-columns:1fr;}}
`

    // ───────────────────────── 面板组件 ─────────────────────────
    function Panel() {
      const [state, setState] = useState({ loading: true, config: null, secrets: {}, errors: [], msg: null })

      const load = useCallback(async () => {
        try {
          const data = await jget()
          if (!data.ok) throw new Error(data.error || '读取失败')
          setState((s) => ({ ...s, loading: false, config: data.config, secrets: data.secrets ?? {}, errors: data.errors ?? [] }))
        } catch (e) {
          setState((s) => ({ ...s, loading: false, msg: { kind: 'bad', text: `读取配置失败：${e.message}` } }))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const set = useCallback((path, v) => {
        setState((s) => ({ ...s, config: setPath(s.config ?? {}, path, v) }))
      }, [])

      const errByPath = useMemo(() => {
        const map = {}
        for (const e of state.errors ?? []) map[e.path] = e.message
        return map
      }, [state.errors])

      const save = useCallback(async () => {
        setState((s) => ({ ...s, msg: null }))
        // patch = 全部非 secret 字段 + 用户实际输入的 secret（留空不带，避免清掉已存的值）
        const patch = {}
        const secretInputs = {}
        for (const g of GROUPS) {
          for (const f of g.fields) {
            const pathKey = f.k.join('.')
            const v = getPath(state.config, f.k)
            if (f.type === 'secret') {
              secretInputs[pathKey] = state[`sec_${pathKey}`] ?? ''
              if ((state[`sec_${pathKey}`] ?? '').length > 0) setPath(patch, f.k, state[`sec_${pathKey}`])
              continue
            }
            if (f.type === 'textlist') {
              setPath(patch, f.k, String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean))
              continue
            }
            if (f.type === 'number') {
              const n = Number(v)
              if (Number.isFinite(n)) setPath(patch, f.k, n)
              continue
            }
            setPath(patch, f.k, v)
          }
        }
        try {
          const data = await jpost(patch)
          if (!data.ok) {
            if (data.errors) setState((s) => ({ ...s, errors: data.errors, msg: { kind: 'bad', text: `有 ${data.errors.length} 处配置不对，已标在下面` } }))
            else if (data.conflict) { setState((s) => ({ ...s, msg: { kind: 'bad', text: data.error } })); load() }
            else setState((s) => ({ ...s, msg: { kind: 'bad', text: data.error || '保存失败' } }))
            return
          }
          setState((s) => ({ ...s, errors: [], msg: { kind: 'ok', text: '已保存 ✓（热更新，立即生效）' } }))
          load()
        } catch (e) {
          setState((s) => ({ ...s, msg: { kind: 'bad', text: `保存失败：${e.message}` } }))
        }
      }, [state.config, state, load])

      const renderField = (f) => {
        const value = getPath(state.config, f.k)
        const err = errByPath[f.k.join('.')]
        const note = h('div', { 'data-ebot-note': '' }, f.note)
        let control = null
        switch (f.type) {
          case 'boolean':
            control = h('label', { 'data-ebot-ctrl': '', style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', { type: 'checkbox', checked: !!value, onChange: (e) => set(f.k, e.target.checked), style: { width: 16, height: 16 } }),
              h('span', { style: { fontSize: 13 } }, value ? '开' : '关'))
            break
          case 'select':
            control = h('select', { 'data-ebot-ctrl': '', value: String(value ?? ''), onChange: (e) => set(f.k, e.target.value) },
              (f.options ?? []).map(([v, label]) => h('option', { key: v, value: v }, label)))
            break
          case 'textarea':
          case 'textlist':
            control = h('textarea', { 'data-ebot-ctrl': '', rows: f.type === 'textlist' ? 3 : 4, value: String(value ?? ''), onChange: (e) => set(f.k, e.target.value) })
            break
          case 'number':
            control = h('input', { 'data-ebot-ctrl': '', type: 'number', value: value ?? '', onChange: (e) => set(f.k, e.target.value) })
            break
          case 'secret': {
            const pathKey = f.k.join('.')
            const isSet = state.secrets?.[pathKey] === true
            control = h('input', {
              'data-ebot-ctrl': '', type: 'password',
              placeholder: isSet ? '（已设置，留空则不改）' : '（未设置）',
              value: state[`sec_${pathKey}`] ?? '',
              onChange: (e) => setState((s) => ({ ...s, [`sec_${pathKey}`]: e.target.value })),
            })
            break
          }
          default:
            control = h('input', { 'data-ebot-ctrl': '', type: 'text', value: String(value ?? ''), onChange: (e) => set(f.k, e.target.value) })
        }
        return h('div', { 'data-ebot-row': '', key: f.k.join('.') },
          h('div', null,
            h('div', { 'data-ebot-label': '' }, f.label),
            err ? h('div', { 'data-ebot-err': '' }, err) : note),
          control)
      }

      return h('div', { 'data-ebot-page': '' },
        h('style', null, CSS),
        h('div', { 'data-ebot-top-note': '' },
          '在这里配置大肥鱼。保存后立即生效；若个别改动没反应，重启一次 DSH。日志在 ~/.dsh/ebot-qq/logs/。'),
        state.loading ? h('div', { 'data-ebot-msg-ok': '' }, '正在读取配置……') : null,
        GROUPS.map((g) => h('div', { 'data-ebot-sec': '', key: g.key },
          h('div', { 'data-ebot-h': '' }, g.title),
          g.fields.map(renderField))),
        h('div', { 'data-ebot-foot': '' },
          h('button', { 'data-ebot-btn': '', onClick: save, disabled: state.loading || !state.config }, '保存'),
          state.msg ? h('span', { ['data-ebot-msg-' + state.msg.kind]: '' }, state.msg.text) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'ebot-qq', order: 20, label: '大肥鱼' },
          Panel,
        ))
      },
    }
  },
})
