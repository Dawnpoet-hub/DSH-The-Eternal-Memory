// Host 侧：本地长期记忆的「无感」实现，规则向 Hindsight 对齐。
// ① 读：每条提问前检索相关记忆，命中的才附加（相关性闸门 + 去重）。
// ② 写：每轮结束立刻提交（1.2s 防抖合并），整段对话按 12k 分块提炼成事实，
//        以 REF-ID 为文档标识、按内容哈希去重——等价于 Hindsight 服务端的
//        "整段 upsert + append + 服务端去重"。
// 任何异常都必须吞掉——绝不能因为记忆插件，把用户的对话卡住。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import path from 'node:path'
import { WS, PY, pyNow, CLI as CLI_PY, SERVE, MEM, STATE_DIR, pythonAvailable } from './paths.js'

const CLI = CLI_PY
const LOG = path.join(STATE_DIR, 'auto.log')
const STATE = path.join(STATE_DIR, 'auto-state.json')
const PLUGIN = 'mem-auto'

const TIMEOUT_MS = 3000          // 单次检索超时
const MIN_PROMPT = 4
const MAX_OUT = 1100
const DEBOUNCE_MS = Number(process.env.MEM_AUTO_IDLE_MS ?? 60_000)  // 停手多久强制提炼
const CONTEXT_TURNS = Number(process.env.MEM_AUTO_CONTEXT ?? 10)     // 每次附带的上下文轮数
const MIN_NEW_TURNS = Number(process.env.MEM_AUTO_MIN_TURNS ?? 8)    // 攒够多少新轮次就提炼
const FALLBACK_TURNS = 20                                            // 锚点失效时整段重发的轮数
// L0：context 只作为「上一轮停顿点」的短背景送进 system，不参与事实抽取。
// 实测（见 docs）：context 占送入轮次的 44%，会被反复提炼成同一事实的不同措辞。
// 设 MEM_AUTO_CTX_EXTRACT=1 可回退到旧行为（context 一并作为可抽取素材）。
const EXTRACT_CONTEXT = process.env.MEM_AUTO_CTX_EXTRACT === '1'
const PRELUDE_CHARS = 200        // 停顿点摘要的字数上限
// L1 写入闸门：写库前先问常驻服务「这条是不是已经有了」（判据见 tools/mem/gate.py）。
// 设 MEM_AUTO_DEDUPE=0 可关掉，退化成只做字面包含去重。
const DEDUPE_GATE = process.env.MEM_AUTO_DEDUPE !== '0'
// 实验/调试开关：MEM_AUTO_INJECT=0 只关「自动召回+注入」，MCP 工具与写回照常；
// MEM_AUTO_WRITE=0 只关「写回」，用来冻结记忆库（做 A/B 对照时防止库在实验中途变大）。
const INJECT_ENABLED = process.env.MEM_AUTO_INJECT !== '0'
const WRITE_ENABLED = process.env.MEM_AUTO_WRITE !== '0'
const GATE_TIMEOUT_MS = Number(process.env.MEM_AUTO_GATE_TIMEOUT ?? 8000)
const CHUNK_CHARS = 12_000       // 与 Hindsight 的 retain_chunk_size 一致
const MAX_CHUNKS = 3
const MAX_ITEMS = 8
let lastSyncAt = 0   // 上次同步 DSH 工作区的时间（新工作区创建后要尽快登记）
const DISTILL_TIMEOUT = 120_000
// 模型不写死：优先环境变量，其次从 DSH 已注册的 provider/模型里挑 deepseek
const MODEL_ENV = { provider: process.env.MEM_LLM_PROVIDER, model: process.env.MEM_LLM_MODEL }
const MODEL_PREFS = ['deepseek-flash', 'deepseek-chat', 'deepseek-v4-flash', 'deepseek-reasoner']
let modelPick = null
let candidatesLogged = false

async function modelCandidates(ctx) {
  const llm = ctx?.get ? ctx.get('llm') : undefined
  if (!llm?.stream) return []

  let providers = [], models = []
  try {
    const r = await llm.listProviders?.()
    if (Array.isArray(r)) providers = r.map((p) => (typeof p === 'string' ? p : p?.id ?? p?.name)).filter(Boolean)
  } catch { /* ignore */ }
  try {
    const r = await llm.listModels?.()
    if (Array.isArray(r)) models = r.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean)
  } catch { /* ignore */ }

  const out = []
  const add = (provider, model) => {
    if (!provider || !model) return
    if (!out.some((x) => x.provider === provider && x.model === model)) out.push({ provider, model })
  }

  add(process.env.MEM_LLM_PROVIDER, process.env.MEM_LLM_MODEL)   // 显式配置最优先
  add('deepseek-account', 'deepseek-flash')                      // 实测可用的默认组合
  add('deepseek-account', 'deepseek-chat')
  for (const p of providers.filter((x) => /deepseek/i.test(x))) add(p, models[0] ?? 'deepseek-flash')
  for (const p of providers) add(p, models[0])
  for (const m of ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']) add('deepseek-official', m)

  if (!candidatesLogged) {
    candidatesLogged = true
    note({ ev: 'model_candidates', n: out.length, list: out.slice(0, 4),
           providers: providers.slice(0, 4), models: models.slice(0, 4) })
  }
  return out
}


function forgetModel() { modelPick = null }

let proc = null
let queue = []
const lastInjected = new Map()
const states = new Map()         // sessionId -> { timer, running, again }

function note(rec) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...rec })}\n`)
  } catch { /* 日志失败不影响主流程 */ }
}

// ---------------- 检索守护进程 ----------------

function killDaemon() {
  if (proc) {
    try { proc.kill('SIGKILL') } catch { /* ignore */ }
    proc = null
  }
  for (const p of queue) p.settle(null)
  queue = []
}

function ask(req, ms = TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!proc) {
      try {
        proc = spawn(pyNow(), [SERVE], { cwd: WS, stdio: ['pipe', 'pipe', 'pipe'] })
        proc.stderr.on('data', () => {})
        proc.on('error', (e) => {
          note({ ev: 'spawn_error', err: String(e).slice(0, 240) })
          proc = null
          for (const q of queue) q.settle(null)
          queue = []
        })
        createInterface({ input: proc.stdout }).on('line', (line) => {
          let obj = null
          try { obj = JSON.parse(line) } catch { /* 非 JSON 按响应处理 */ }
          if (obj && (obj.ready || obj.warn)) return   // 启动握手不是响应
          const pending = queue.shift()
          if (pending) pending.settle(line)
        })
        proc.on('exit', () => { proc = null })
      } catch (e) {
        note({ ev: 'spawn_fail', err: String(e) })
        return resolve(null)
      }
    }

    let done = false
    const entry = {
      settle: (line) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(line)
      },
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      note({ ev: 'timeout' })
      killDaemon()
      resolve(null)
    }, ms)

    queue.push(entry)
    try {
      proc.stdin.write(`${JSON.stringify(req)}\n`)
    } catch (e) {
      note({ ev: 'write_fail', err: String(e) })
      entry.settle(null)
    }
  })
}

const projectCache = new Map()

async function projectInfo(agent) {
  const cwd = agent?.session?.header?.cwd || WS
  const hit = projectCache.get(cwd)
  if (hit) return hit
  const raw = await ask({ op: 'project', cwd })
  let info = { project: 'main', root: MEM }
  try {
    const d = JSON.parse(raw ?? '{}')
    if (d.project) info = { project: d.project, root: path.join(WS, d.root || 'memory') }
  } catch { /* 用默认 */ }
  projectCache.set(cwd, info)
  return info
}

async function recall(prompt, project) {
  const raw = await ask({ op: 'context', q: prompt.slice(0, 400), top: 3, budget: 900, project })
  if (!raw) return ''
  try {
    const data = JSON.parse(raw)
    if (data.error) { note({ ev: 'recall_error', err: data.error }); return '' }
    return (data.text ?? '').trim()
  } catch {
    return ''
  }
}

// ---------------- 会话事件 → 对话记录（对齐 Hindsight 的 readDshEvents） ----------------

function eventsOf(agent) {
  const s = agent?.session
  if (!s) return []
  try {
    return s.snapshotEvents?.() ?? s.events ?? []
  } catch {
    return []
  }
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 去掉我们自己注入过的记忆块，避免「注入 → 再提炼 → 越滚越大」 */
function stripInjected(s) {
  return String(s)
    .replace(/🧠[^\n]*\n[\s\S]*?（来自本机记忆库[\s\S]*?）\n?/g, '')
    .replace(/<memory-recall>[\s\S]*?<\/memory-recall>/g, '')
}

const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'name', 'id']

/** 「工具名 + 目标」一行，不带参数与输出（和 Hindsight 的 actionLine 一致） */
function actionLine(tool, rawArgs) {
  let input = rawArgs
  if (typeof rawArgs === 'string') {
    try { input = JSON.parse(rawArgs) } catch { /* 保持字符串 */ }
  }
  let target = ''
  if (input && typeof input === 'object') {
    for (const k of TARGET_KEYS) {
      const v = input[k]
      if (typeof v === 'string' && v.trim()) { target = v.trim().split('\n')[0]; break }
    }
  } else if (typeof input === 'string') {
    target = input.trim().split('\n')[0]
  }
  if (target.length > 100) target = `${target.slice(0, 100)}…`
  return target ? `${tool} ${target}` : String(tool)
}

function turnsOf(agent) {
  const turns = []
  for (const ev of eventsOf(agent)) {
    if (!ev || typeof ev !== 'object') continue
    const ts = typeof ev.time === 'number' ? { timestamp: new Date(ev.time).toISOString() } : {}
    if (ev.type === 'user/message') {
      const msg = ev.data
      if (!msg || msg.source?.kind !== 'user') continue
      const text = stripInjected(textOf(msg)).trim()
      if (text) turns.push({ role: 'user', content: text, ...ts })
    } else if (ev.type === 'assistant/message') {
      const msg = ev.data?.message
      if (!msg) continue
      const text = stripInjected(textOf(msg)).trim()
      if (text) turns.push({ role: 'assistant', content: text, ...ts })
    } else if (ev.type === 'tool/call') {
      const call = ev.data
      if (!call?.name) continue
      turns.push({ role: 'action', content: actionLine(call.name, call.arguments), ...ts })
    }
  }
  return turns
}

function renderJsonl(sessionId, turns) {
  const lines = [JSON.stringify({ role: 'system', content: `REF-ID: conversation:${sessionId}` })]
  for (const t of turns) lines.push(JSON.stringify({ role: t.role, content: t.content, timestamp: t.timestamp }))
  return lines.join('\n')
}

/**
 * 从 context 轮次里抽一句「上一轮停顿点」。
 * 目的只是让模型知道「改成这样」指的是什么，不给它可抽取的素材。
 * 优先取最后一条 assistant，没有就取最后一条任何消息。
 */
function preludeFrom(context) {
  if (!Array.isArray(context) || context.length === 0) return ''
  const rev = [...context].reverse()
  const last = rev.find((t) => t && t.role === 'assistant' && t.content)
    || rev.find((t) => t && t.content)
  if (!last) return ''
  const text = String(last.content).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > PRELUDE_CHARS ? `${text.slice(0, PRELUDE_CHARS)}…` : text
}

function chunkJsonl(jsonl, size = CHUNK_CHARS, maxChunks = MAX_CHUNKS) {
  if (jsonl.length <= size) return [jsonl]
  const chunks = []
  let buf = ''
  for (const line of jsonl.split('\n')) {
    if (buf.length + line.length + 1 > size && buf) {
      chunks.push(buf)
      buf = ''
      if (chunks.length >= maxChunks) break
    }
    buf += `${line}\n`
  }
  if (buf && chunks.length < maxChunks) chunks.push(buf)
  return chunks
}

// ---------------- 状态持久化（等价于服务端「按文档去重」） ----------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return { sessions: {} }
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify(state), 'utf8')
  } catch (e) {
    note({ ev: 'state_save_fail', err: String(e) })
  }
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)

// ---------------- 提炼 ----------------

const EXTRACT_PROMPT = `你在把一段开发者对话（JSONL，每行一个 {role, content} 轮次）转成长期记忆事实。

素材里可能包含：
- user：用户的原话
- assistant：助手的叙述
- action：一行「工具名 + 目标」（例如 "Edit memory/doorbell.md"），不含参数与输出

请提取「最少但完整」的事实，覆盖对话的结果：
- 已确定的决定，以及它们的精确规则、取值、字面值
- 对具体文件/函数/配置的实际改动
- 遇到的问题与解决方式
- 确立的约定或不变量
- 被否决的方案：最多一条，写成「最初用 X，后来改成 Y，因为 Z」
- 排查过程与验证手法：试探、二分定位、状态检查、临时改动、等待验证的结果 —— 用 category「过程」

必须遵守：
1. 对话会自我修订。**只把最终生效的结论记为决定**；被推翻的旧方案只能出现在上面那条「被否决」的事实里，绝不单独成为一条「决定」。同一个设置改过多次，只保留最后一次，并说清哪个胜出。
2. 具体数值、路径、文件名、命令、接口名、字面值，**原样抄写**，不许改写、概括或省略。
3. 不要为每条消息、每个中间方案、每个 action 各写一条。短对话通常 1–2 条，长对话也很少超过 6 条。
4. 不要编造。只写对话里真正定下来的东西。
5. 每一条都必须原样保留开头的 REF-ID 标记。
6. **分清「过程」和「结果」，两者都要记，但绝不能混**：
   - **结果**＝最终生效的规则、取值、文件改动、约定。category 用 决定 / 约束 / 环境 / 原因 / 事实。
   - **过程**＝当时的状态检查、试探、二分定位、临时改动、验证手法、等待某结果。**category 必须用「过程」**，
     严禁写成「决定」或「事实」。
   - 判据一句话：**这句话描述的东西，下个月还在不在？** 不在 → 过程；在 → 结果。
   - 过程里如果夹着有效结论，把结论单独抽成一条结果，过程那条只描述过程。
   - 过程不要带「等待验证」「暂定」这类未完成的语气当成结论写。

只输出 JSON 数组，不要解释、不要代码块。每项格式：
{"type":"decision|environment|principles","category":"决定|原因|约束|环境|偏好|事实|过程","text":"一句话，含具体字面值","refId":"原样复制的 REF-ID","note":"归入哪篇笔记（优先复用已有标题，没有就新拟一个）","page":"归入哪个主题页，2–6 个字","entities":["这条事实涉及的具体名词"],"because":"如果这条是原因，写明它解释的是哪一条已有结论（抄那一条的原文开头 12–24 字）"}

entities 说明：填**可被搜索的具体名词**——文件路径、色值、接口/函数名、组件名、产品名、命令名。
- 每条事实 1–4 个，超过 4 个说明这条事实不聚焦，应拆开。
- 用原文里的写法（例如 "#3A7A3A"、"tools/mem/search.py"、"mem_search"），不要自己起名。
- 没有具体名词就填空数组 []。

because 说明：只在「原因/约束」类事实里填，指向它解释的那条决定；没有就省略。

page 说明：同一主题必须用**完全相同的名字**（例如"门铃UI"、"DSH插件"、"MasterGo"）。这是把零散事实聚合成页面的唯一依据，名字漂移会导致主题被拆散。

已有笔记标题：`

function normText(t) {
  return String(t).replace(/[\s，。、,.!?！？:：;；"'“”‘’（）()\[\]【】#]/g, '').toLowerCase()
}

function existingFacts(dir = MEM) {
  const out = new Set()
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const body = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of body.matchAll(/^-\s*\[[^\]]+\]\s*(.+)$/gm)) out.add(normText(m[1]))
    }
  } catch { /* ignore */ }
  return out
}

function existingTitles(dir = MEM) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

function parseFacts(text) {
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.text === 'string' && x.text.trim())
      : []
  } catch {
    return []
  }
}


// 自动挑模型调用：按候选梯队逐个尝试，避免把 ctx 错当成 pick 传进去
async function callModelAuto(ctx, llm, system, user) {
  const seen = new Set()
  const ladder = [modelPick, ...(await modelCandidates(ctx))]
    .filter((p) => p && !seen.has(`${p.provider}/${p.model}`) && seen.add(`${p.provider}/${p.model}`))
  let lastErr = null
  for (const pick of ladder) {
    try {
      return await callModel(pick, llm, system, user)
    } catch (e) {
      lastErr = e
      note({ ev: 'model_try_fail', where: 'auto', provider: pick.provider, model: pick.model, err: String(e).slice(0, 240) })
    }
  }
  throw lastErr ?? new Error('no llm candidate')
}

async function callModel(pick, llm, system, user) {
  // 逐级降级：某些请求在部分 DSH 版本上会被服务端以 INVALID_REQUEST / TRANSPORT 拒掉，
  // 而同一模型的简单请求正常。这里按「完整 → 去 system → 截断正文」三档重试，
  // 成功时记下用了哪一档，便于定位；三档都失败才抛出最后一档的错误。
  // 实测（2026-11-19，DSH 0.2.2-rc.5）：
  //   ① 带 system 角色的请求会被服务端拒掉（INVALID_REQUEST），只有 user 消息通过；
  //   ② 但丢掉规则，模型就不知道输出格式（提炼出 0 条）；
  //   ③ 规则+材料的合并报文在**较长**时又被拒（短的自检能通）。
  // 所以分四档，且截断只截材料、**绝不截规则**：
  const build = (material) => (system ? `【规则】\n${system}\n\n【材料】\n${material}` : material)
  const attempts = [
    { tag: 'merged', system: '', user: build(user) },
    { tag: 'merged-trim', system: '', user: build(String(user).slice(-4000)) },
    { tag: 'merged-tiny', system: '', user: build(String(user).slice(-1500)) },
    { tag: 'no-rules', system: '', user: String(user).slice(-4000) },
  ]
  let lastErr = null
  for (const a of attempts) {
    try {
      const r = await streamOnce(pick, llm, a.system, a.user)
      if (a.tag !== 'full') note({ ev: 'model_degraded', tag: a.tag, provider: pick.provider, model: pick.model })
      return r
    } catch (e) {
      lastErr = e
      if (a.tag !== 'full') note({ ev: 'model_degraded_fail', tag: a.tag, err: String(e).slice(0, 200) })
    }
  }
  throw lastErr ?? new Error('no llm candidate')
}

// 服务端报过 "unexpected end of hex escape"：按字符位置切串会把 emoji/代理对切成
// 孤立的高位或低位代理，序列化成 \uD83D 这种残缺转义，整个报文被判非法 JSON。
// 所有送出去的文本都要先净化。
function sanitizeText(t) {
  return String(t ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')      // 孤立高位代理
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')      // 孤立低位代理
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ') // 控制字符
}

async function streamOnce(pick, llm, system, user) {
  if (!pick) throw new Error('no llm candidate')
  const parts = []
  const messages = []
  if (system) messages.push({ role: 'system', content: [{ type: 'text', text: sanitizeText(system) }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: sanitizeText(user) }] })
  let usage = null
  let finish = null
  const unknown = new Set()
  for await (const chunk of llm.stream({ provider: pick.provider, model: pick.model, messages })) {
    const type = chunk?.type
    if (type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
    else if (type === 'usage') usage = chunk.usage ?? chunk
    else if (type === 'finish') finish = chunk
    else if (type && type !== 'block-start' && type !== 'block-end' && !unknown.has(type)) {
      unknown.add(type)
      note({ ev: 'chunk_unknown', type, sample: JSON.stringify(chunk).slice(0, 160) })
    }
  }
  const text = parts.join('')
  if (!text.trim()) {
    const kind = finish?.reason?.kind
    const failure = finish?.reason?.failure
    const detail = kind === 'error'
      ? `adapter-error ${(failure?.code ?? '')} ${String(failure?.message ?? '').slice(0, 160)}`.trim()
      : `finish=${kind ?? '?'} parts=${parts.length}`
    throw new Error(`empty model output (${pick.provider}/${pick.model}) ${detail}`)
  }
  return { text, usage }
}

function slugify(title) {
  return String(title).trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `自动记忆-${Date.now()}`
}

/**
 * 从 mem.json 反查「根目录 → 项目名」，用来给 frontmatter 填 project。
 *
 * 为什么不用写死的 'main'：别人从 git 装下来可能配置了多个工作区（roots 里各有
 * name），写死会让所有笔记都标成 main。这里和 tools/mem/core.py 的
 * load_projects() 遵循同一套规则，所以两边算出来的项目名一致。
 *
 * 兜底顺序：mem.json 里精确匹配 → 该目录的 basename → 'main'
 * （最后一级只在 mem.json 缺失/读不出来时才会走到，与 core.py 的缺省行为一致）
 */
let projectRootMap = { at: -1, map: new Map() }
function projectForRoot(root) {
  const target = path.resolve(root || MEM)
  try {
    const cfgPath = path.join(WS, 'mem.json')
    const st = fs.statSync(cfgPath)
    if (st.mtimeMs !== projectRootMap.at) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const map = new Map()
      for (const r of cfg.roots ?? []) {
        if (!r || !r.path) continue
        map.set(path.resolve(WS, r.path), String(r.name || 'main'))
      }
      projectRootMap = { at: st.mtimeMs, map }
    }
    const hit = projectRootMap.map.get(target)
    if (hit) return hit
  } catch { /* mem.json 没有或读不动，走兜底 */ }
  if (target === path.resolve(WS, 'memory')) return 'main'
  return path.basename(target) || 'main'
}

// 笔记类型按「第一条观察的类别」决定，不直接信模型给的 type：
// 模型可能给 type=decision 而 category=事实，写出来的笔记就变成
// 「decision 类型但没有一条 [决定]」，体检会报错（schema 要求 decision 至少一条决定）。
function typeForCategory(cat, hint) {
  const c = String(cat || '').trim()
  if (c === '决定') return 'decision'
  if (c === '环境') return 'environment'
  if (c === '原则' || c === '偏好') return 'principles'
  if (c === '事实' || c === '约束' || c === '原因' || c === '过程') return 'note'
  return ['decision', 'environment', 'principles'].includes(hint) ? hint : 'note'
}

function appendFact(fact, refId, root = MEM) {
  const title = String(fact.note || fact.type || '自动记忆').trim()
  const file = path.join(root, `${slugify(title)}.md`)
  const today = new Date().toISOString().slice(0, 10)
  const cat = String(fact.category || '事实').trim()
  const text = String(fact.text).trim()
  const clean = (t) => String(t).replace(/[·()（）\n|]/g, ' ').trim()
  const page = clean(fact.page || '')
  const ents = (Array.isArray(fact.entities) ? fact.entities : [])
    .map(clean).filter((x) => x && x.length <= 80).slice(0, 6)
  const cause = clean(fact.because || '').slice(0, 80)
  const meta = [
    page ? `page:${page}` : '',
    ents.length ? `entities:${ents.join('|')}` : '',
    cause ? `because:${cause}` : '',
    refId,
    `自动提炼 ${today}`,
  ].filter(Boolean).join(' · ')
  const line = `- [${cat}] ${text} (${meta})`

  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8')
    if (body.includes(normText(text).slice(0, 20)) || body.includes(text)) return false
    const next = /^## 观察/m.test(body)
      ? `${body.replace(/\s*$/, '')}\n${line}\n`
      : `${body.replace(/\s*$/, '')}\n\n## 观察\n${line}\n`
    fs.writeFileSync(file, next, 'utf8')
    return true
  }

  const type = typeForCategory(cat, fact.type)
  fs.writeFileSync(file, [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `project: ${projectForRoot(root)}`,
    'tags: [auto]',
    `created: ${today}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## 观察',
    line,
    '',
  ].join('\n'), 'utf8')
  return true
}

/**
 * L1 写入闸门：把一批待写入事实交给常驻服务判重。
 * 判据见 tools/mem/gate.py（余弦 + 字面值 + 类别 + 元数据四道闸，与 audit 同口径）。
 * 任何失败都返回 null —— 闸门坏掉只能退化成"少去重"，绝不能阻断写入。
 *
 * 已知局限：索引由 `mem index --update` 异步更新，同一批次刚写入的条目可能还没进库，
 * 闸门看不到它们；这部分由前面的 existingFacts() 字面包含兜底。
 */
async function gateCheck(facts) {
  if (!DEDUPE_GATE) return null
  const batch = facts.slice(0, MAX_ITEMS)
  if (!batch.length) return null
  const items = batch.map((f) => ({
    text: String(f.text || '').trim(),
    category: String(f.category || '事实').trim(),
    note: `${slugify(String(f.note || f.type || '自动记忆').trim())}.md`,
  }))
  try {
    const raw = await ask({ op: 'dupcheck', items }, GATE_TIMEOUT_MS)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data.error || !Array.isArray(data.results)) return null
    return data.results
  } catch (e) {
    note({ ev: 'gate_error', err: String(e).slice(0, 240) })
    return null
  }
}

async function writeFacts(facts, refId, seen, root = MEM) {
  const known = existingFacts(root)
  const verdicts = await gateCheck(facts)
  let written = 0, dup = 0, gated = 0
  for (let i = 0; i < facts.length && i < MAX_ITEMS; i++) {
    const f = facts[i]
    const key = normText(f.text)
    if (seen.has(key) || (key.length > 8 && [...known].some((k) => k.includes(key) || key.includes(k)))) {
      dup++
      continue
    }
    const verdict = verdicts?.[i]
    if (verdict?.verdict === 'dup') {
      gated++
      note({ ev: 'gate_skip', score: verdict.score, line: verdict.target_line,
             note: String(f.note || '').slice(0, 40) })
      continue
    }
    try {
      if (appendFact(f, refId, root)) {
        written++
        seen.add(key)
        known.add(key)
      }
    } catch (e) {
      note({ ev: 'write_fail', err: String(e) })
    }
  }
  if (verdicts) {
    const scores = verdicts.map((v) => v?.score).filter((s) => typeof s === 'number')
    note({ ev: 'gate', n: verdicts.length, gated,
           maxScore: scores.length ? Math.max(...scores) : null })
  }
  if (written) {
    try {
      spawn(pyNow(), [CLI, 'index', '--update'], { cwd: WS, stdio: 'ignore' }).on('error', () => {}).unref()
    } catch { /* ignore */ }
  }
  return { written, dup, gated }
}


async function distillJsonl(ctx, llm, jsonl, prelude = '') {
  const system = [
    EXTRACT_PROMPT,
    prelude
      ? `【上一轮停顿点 · 仅背景】\n下面这段是上一轮结束时的上下文，只用于理解「改成这样」「就是这个」之类的指代。\n**严禁从中抽出任何事实**——可提炼的素材只有下面 JSONL 里的轮次。\n${prelude}`
      : '',
    `【已有笔记标题】\n${existingTitles().join('、')}`,
  ].filter(Boolean).join('\n\n')
  const chunks = chunkJsonl(jsonl)
  const facts = []
  const usage = { input_tokens: 0, output_tokens: 0 }
  const startedAt = Date.now()
  for (const chunk of chunks) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('distill timeout')), DISTILL_TIMEOUT))
    let res = null
    let lastErr = null
    const seenPick = new Set()
    const ladder = [modelPick, ...(await modelCandidates(ctx))]
      .filter((p) => p && !seenPick.has(`${p.provider}/${p.model}`) && seenPick.add(`${p.provider}/${p.model}`))
    for (const pick of ladder) {
      try {
        res = await Promise.race([callModel(pick, llm, system, chunk), timeout])
        if (modelPick && (modelPick.provider !== pick.provider || modelPick.model !== pick.model)) {
          note({ ev: 'model_switch', provider: pick.provider, model: pick.model })
        }
        modelPick = pick
        break
      } catch (e) {
        lastErr = e
        note({ ev: 'model_try_fail', provider: pick.provider, model: pick.model, err: String(e).slice(0, 100) })
      }
      if (Date.now() - startedAt > 90_000) break   // 别把所有组合都试一遍拖太久
    }
    if (!res) { forgetModel(); throw lastErr ?? new Error('all candidates failed') }
    facts.push(...parseFacts(res.text))
    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens ?? 0
      usage.output_tokens += res.usage.output_tokens ?? 0
    }
  }
  return { facts, usage, chunks: chunks.length }
}


// ---------------- 历史会话回填 ----------------

const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions')
const BACKFILL_STATE = path.join(STATE_DIR, 'backfill.json')
const BACKFILL_MAX_CHARS = 48_000
const BACKFILL_ENABLED = process.env.MEM_AUTO_BACKFILL !== '0'

/** zstd 多帧：按 RFC 8878 走帧头与块头，逐帧解压后拼接 */
function frameLength(buf, off) {
  let p = off
  const magic = buf.readUInt32LE(p)
  if ((magic & 0xFFFFFFF0) === 0x184D2A50) return 8 + buf.readUInt32LE(p + 4)
  if (magic !== 0xFD2FB528) return -1
  p += 4
  const fhd = buf[p]; p += 1
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  if (!single) p += 1
  p += [0, 1, 2, 4][fhd & 3]
  p += [single ? 1 : 0, 2, 4, 8][fcsFlag]
  while (true) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const type = (bh >> 1) & 3
    p += type === 1 ? 1 : (bh >>> 3)
    if (bh & 1) break
  }
  if (checksum) p += 4
  return p - off
}

function readSession(file) {
  const buf = fs.readFileSync(file)
  let off = 0
  const parts = []
  while (off < buf.length) {
    const len = frameLength(buf, off)
    if (len <= 0) break
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len))) } catch { break }
    off += len
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function listSessionFiles() {
  const out = []
  try {
    for (const slug of fs.readdirSync(SESSIONS_DIR)) {
      const base = path.join(SESSIONS_DIR, slug)
      if (!fs.statSync(base).isDirectory()) continue
      for (const sid of fs.readdirSync(base)) {
        const f = path.join(base, sid, 'session.v4.jsonl.zstd')
        if (fs.existsSync(f)) out.push({ id: sid, file: f, size: fs.statSync(f).size })
      }
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.size - b.size)     // 小的先做，快速见到效果
}

/** 会话事件 → 对话记录（与实时链路同一套归一化） */
function turnsFromEvents(events) {
  const turns = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'user/message') {
      const msg = ev.data
      if (!msg || msg.source?.kind !== 'user') continue
      const text = stripInjected(textOf(msg)).trim()
      if (text) turns.push({ role: 'user', content: text })
    } else if (ev.type === 'assistant/message') {
      const msg = ev.data?.message
      if (!msg) continue
      const text = stripInjected(textOf(msg)).trim().slice(0, 600)
      if (text) turns.push({ role: 'assistant', content: text })
    } else if (ev.type === 'tool/call') {
      const call = ev.data
      if (!call?.name) continue
      turns.push({ role: 'action', content: actionLine(call.name, call.arguments) })
    }
  }
  return turns
}

function loadBackfill() {
  try { return JSON.parse(fs.readFileSync(BACKFILL_STATE, 'utf8')) } catch { return { done: {} } }
}

function saveBackfill(state) {
  try {
    fs.mkdirSync(path.dirname(BACKFILL_STATE), { recursive: true })
    fs.writeFileSync(BACKFILL_STATE, JSON.stringify(state, null, 1), 'utf8')
  } catch { /* ignore */ }
}

function cwdOf(events) {
  for (const ev of events) {
    if (ev?.cwd) return ev.cwd
    if (ev?.data?.cwd) return ev.data.cwd
  }
  return WS
}

let backfillBusy = false

// 回填进度写进 state 的 meta：分母是「当前还在磁盘上的历史会话数」，
// 分子是其中已经处理过的。原来面板把分母写死成 9、分子按历史累计，
// 于是出现「已完成 58 / 9」这种自相矛盾的数字。
function refreshBackfillMeta() {
  try {
    const state = loadBackfill()
    const files = listSessionFiles()
    const ids = new Set(files.map((x) => x.id))
    const doneNow = files.filter((x) => {
      const d = state.done?.[x.id]
      return d && !d.error && !d.skipped
    }).length
    state.meta = {
      total: files.length,
      done: doneNow,
      pending: files.length - doneNow,
      updatedAt: new Date().toISOString(),
    }
    saveBackfill(state)
    return state.meta
  } catch { return null }
}

async function backfillStep(ctx) {
  if (!BACKFILL_ENABLED || backfillBusy) return
  backfillBusy = true
  try {
    await backfillOne(ctx)
  } finally {
    backfillBusy = false
  }
}

async function backfillOne(ctx) {
  const llm = ctx.get ? ctx.get('llm') : undefined
  if (!llm?.stream) return
  const state = loadBackfill()
  const next = listSessionFiles().find((x) => !state.done[x.id])
  if (!next) return

  try {
    const events = readSession(next.file)
    const turns = turnsFromEvents(events)
    if (turns.length < 4) { state.done[next.id] = { skipped: 'too-short' }; saveBackfill(state); refreshBackfillMeta(); return }

    const info = await projectInfo({ session: { header: { cwd: cwdOf(events) } } })
    let jsonl = renderJsonl(next.id, turns)
    if (jsonl.length > BACKFILL_MAX_CHARS) {
      const half = Math.floor(BACKFILL_MAX_CHARS / 2)
      jsonl = `${jsonl.slice(0, half)}\n${jsonl.slice(-half)}`
    }

    const t0 = Date.now()
    const { facts, usage } = await distillJsonl(ctx, llm, jsonl)
    const res = await writeFacts(facts, `conversation:${next.id}`, new Set(state.done[next.id]?.seen ?? []), info.root)

    state.done[next.id] = { at: new Date().toISOString(), turns: turns.length,
                            facts: facts.length, written: res.written, dup: res.dup,
                            project: info.project, chars: jsonl.length }
    saveBackfill(state)
    refreshBackfillMeta()
    const left = listSessionFiles().filter((x) => !state.done[x.id]).length
    note({ ev: 'backfill', session: next.id.slice(0, 12), turns: turns.length,
           facts: facts.length, written: res.written, dup: res.dup,
           ms: Date.now() - t0, left, usage })
  } catch (e) {
    note({ ev: 'backfill_error', session: next.id.slice(0, 12), err: String(e).slice(0, 240) })
    state.done[next.id] = { error: String(e).slice(0, 120) }
    saveBackfill(state)
    refreshBackfillMeta()
  }
}

export const __test = { readSession, turnsFromEvents, listSessionFiles, frameLength }

// ---------------- 失败重试队列（落盘，重启后继续） ----------------


const QUEUE = path.join(STATE_DIR, 'queue.json')
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 5 * 60 * 1000

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE, 'utf8')) } catch { return [] }
}

function saveQueue(items) {
  try {
    fs.mkdirSync(path.dirname(QUEUE), { recursive: true })
    fs.writeFileSync(QUEUE, JSON.stringify(items), 'utf8')
  } catch (e) { note({ ev: 'queue_save_fail', err: String(e) }) }
}

function enqueue(item) {
  const q = loadQueue()
  if (q.some((x) => x.refId === item.refId && x.jsonl === item.jsonl)) return
  q.push({ ...item, attempts: 1, nextAt: Date.now() + RETRY_BASE_MS })
  saveQueue(q.slice(-20))          // 只留最近 20 条，防止无限膨胀
  note({ ev: 'queue_len', n: q.length })
}

async function drainQueue(ctx) {
  const q = loadQueue()
  if (!q.length) return 0
  const llm = ctx.get ? ctx.get('llm') : undefined
  if (!llm?.stream) return 0
  const keep = []
  let ok = 0
  for (const item of q) {
    if (Date.now() < (item.nextAt || 0)) { keep.push(item); continue }
    try {
      // 修：原先写成 distillJsonl(llm, item.jsonl)，参数错位（签名是 ctx, llm, jsonl），
      // 导致失败重放必然抛错、被静默丢弃。
      const { facts } = await distillJsonl(ctx, llm, item.jsonl, item.prelude || '')
      if (!facts.length) {
        // 0 条不是「已经处理完」，而是这次没提炼出来（例如提示词被降级掉了）。
        // 当成功会把内容静默丢掉，所以退回队列等下次重试。
        item.attempts = (item.attempts || 1)
        if (item.attempts > MAX_ATTEMPTS) { note({ ev: 'queue_drop', refId: item.refId, err: 'empty-facts' }); continue }
        item.nextAt = Date.now() + RETRY_BASE_MS * item.attempts
        keep.push(item)
        note({ ev: 'queue_empty_facts', attempts: item.attempts })
        continue
      }
      const res = await writeFacts(facts, item.refId, new Set(item.seen || []), item.root || MEM)
      ok++
      note({ ev: 'queue_ok', written: res.written })
    } catch (e) {
      item.attempts = (item.attempts || 1) + 1
      if (item.attempts > MAX_ATTEMPTS) {
        note({ ev: 'queue_drop', refId: item.refId, err: String(e).slice(0, 80) })
      } else {
        item.nextAt = Date.now() + RETRY_BASE_MS * item.attempts
        keep.push(item)
      }
    }
  }
  saveQueue(keep)
  return ok
}

// ---------------- 调度：每轮提交，短防抖合并 ----------------

function turnsFingerprint(turn) {
  return hash(`${turn?.role ?? ''}:${turn?.content ?? ''}`)
}

/** 计算本次要处理的区间：锚点之后的增量 + 前面 CONTEXT_TURNS 轮上下文 */
function planWindow(turns, sess) {
  let start = Number(sess.anchorTurns ?? 0)
  const fallbackStart = Math.max(0, turns.length - FALLBACK_TURNS)

  if (start > 0) {
    if (start > turns.length) {
      note({ ev: 'anchor_ahead', anchor: start, actual: turns.length })
      start = fallbackStart
    } else {
      const fp = turnsFingerprint(turns[start - 1])
      if (sess.anchorFingerprint && fp !== sess.anchorFingerprint) {
        note({ ev: 'anchor_mismatch' })
        start = fallbackStart
      }
    }
  }
  const fresh = turns.slice(start)
  const contextStart = Math.max(0, start - CONTEXT_TURNS)
  const context = turns.slice(contextStart, start)
  return { start, fresh, context, usedFallback: start === fallbackStart && start > 0 }
}

function schedule(ctx, agent, delayMs = DEBOUNCE_MS, force = false) {
  const id = agent?.session?.header?.id
  if (!id) return
  const st = states.get(id) ?? { timer: null, running: false, again: false }
  if (st.timer) clearTimeout(st.timer)
  st.timer = setTimeout(() => { run(ctx, agent, id, force) }, delayMs)
  states.set(id, st)
}

function maybeDistill(ctx, agent) {
  const id = agent?.session?.header?.id
  if (!id) return
  const st = states.get(id) ?? { timer: null, running: false, again: false }
  if (st.running) { st.again = true; return }

  let freshCount = 0
  try {
    const state = loadState()
    const sess = state.sessions[id] ?? {}
    freshCount = planWindow(turnsOf(agent), sess).fresh.length
  } catch { /* 读不到就按空闲兜底 */ }

  if (freshCount >= MIN_NEW_TURNS) {
    if (st.timer) clearTimeout(st.timer)
    st.timer = null
    states.set(id, st)
    note({ ev: 'trigger_full', fresh: freshCount })
    run(ctx, agent, id, false)
  } else {
    schedule(ctx, agent, DEBOUNCE_MS, true)   // 停手 60 秒后强制写
  }
}

async function run(ctx, agent, id, force = false) {
  const st = states.get(id)
  if (!st) return
  if (st.running) { st.again = true; return }
  st.running = true
  try {
    const llm = ctx.get ? ctx.get('llm') : undefined
    if (!llm?.stream) { note({ ev: 'no_llm' }); return }

    const info = await projectInfo(agent)
    const turns = turnsOf(agent)
    const refId = `conversation:${id}`
    if (turns.length < 2) { note({ ev: 'skip_empty', turns: turns.length }); return }

    const state = loadState()
    const sess = state.sessions[id] ?? { anchorTurns: 0, anchorFingerprint: null, seen: [], turns: 0 }

    const { start, fresh, context, usedFallback } = planWindow(turns, sess)
    if (fresh.length === 0) { note({ ev: 'unchanged' }); return }
    if (!force && fresh.length < MIN_NEW_TURNS) {
      note({ ev: 'waiting', fresh: fresh.length, need: MIN_NEW_TURNS })
      return
    }

    // L0：默认只把 fresh 当可抽取素材；context 压成一句停顿点放进 system。
    const payload = EXTRACT_CONTEXT ? [...context, ...fresh] : fresh
    const prelude = EXTRACT_CONTEXT ? '' : preludeFrom(context)
    const jsonl = renderJsonl(id, payload)
    const digest = hash(jsonl)
    const seen = new Set(sess.seen)
    const t0 = Date.now()
    let facts, usage, chunks = 0
    try {
      ({ facts, usage, chunks } = await distillJsonl(ctx, llm, jsonl, prelude))
    } catch (e) {
      // 失败落盘 → 之后重放，不依赖这次会话还没结束
      enqueue({ refId, root: info.root, jsonl, prelude, seen: [...seen] })
      note({ ev: 'queued', reason: String(e).slice(0, 80) })
      return
    }

    const { written, dup, gated } = await writeFacts(facts, refId, seen, info.root)
    const turnsCount = (sess.turns ?? 0) + 1
    state.sessions[id] = {
      anchorTurns: turns.length,
      anchorFingerprint: turnsFingerprint(turns[turns.length - 1]),
      lastHash: digest,
      seen: [...seen].slice(-500),
      turns: turnsCount,
    }
    saveState(state)

    note({ ev: 'distill', ms: Date.now() - t0, project: info.project,
           sid: String(id).slice(0, 12),
           provider: modelPick?.provider, model: modelPick?.model,
           totalTurns: turns.length, from: start, fresh: fresh.length, context: context.length,
           preludeChars: prelude.length, extractContext: EXTRACT_CONTEXT || undefined,
           fallback: usedFallback || undefined,
           chars: jsonl.length, charsPerCall: Math.round(jsonl.length / Math.max(1, chunks)),
           chunks, facts: facts.length, written, dup, gated, usage })
  } catch (e) {
    if (/model|provider|unknown/i.test(String(e))) forgetModel()
    note({ ev: 'distill_error', sid: String(id).slice(0, 12), err: String(e) })
  } finally {
    st.running = false
    if (st.again) {
      st.again = false
      schedule(ctx, agent, DEBOUNCE_MS, true)
    }
  }
}

// ---------------- 注入 ----------------

function promptOf(messages) {
  return (messages ?? [])
    .filter((m) => m?.source?.kind === 'user')
    .flatMap((m) => m.content ?? [])
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN}`, form: 'recall' },
  }
}

function compose(contextText, first) {
  // 旧版写的是「可能只是擦边；判断后再用」——这句本身就在诱导复核，
  // 实测注入组因此多花数倍预算。改成按核验状态给行动指令。
  const legend = '✅ = 引用的文件/符号/数值在核验时点仍在，可直接当事实用，不必再核对原文；\n'
    + '🔗 = 没有可核验的引用，要当结论用请打开原文。\n\n'
  const head = first
    ? `🧠 你有本地长期记忆库（memory/），下面是从中检索到的内容，每条都标了核验状态：\n${legend}`
    : `🧠 本地长期记忆里可能相关的内容：\n${legend}`
  const body = contextText.length > MAX_OUT ? `${contextText.slice(0, MAX_OUT)}…` : contextText
  return `${head}${body}\n\n（来自本机记忆库 memory/。需要更多可调用 mem_search，写入用 mem_write_note。）`
}

// ---------------- 插件 ----------------

export function apply(ctx) {
  note({ ev: 'plugin_loaded' })

  // 启动自检：发一次最小请求，把「通道问题」和「报文问题」分开。
  // 通道坏 → selftest 失败；通道好但提炼失败 → 报文/长度/内容问题。
  try { refreshBackfillMeta() } catch { /* 启动时算一次，面板立刻有真实分母 */ }

  setTimeout(async () => {
    try {
      const llm = ctx.get ? ctx.get('llm') : undefined
      if (!llm?.stream) { note({ ev: 'llm_selftest_skip', why: 'no-llm' }); return }
      const pick = modelPick ?? (await modelCandidates(ctx))[0]
      if (!pick) { note({ ev: 'llm_selftest_skip', why: 'no-candidate' }); return }
      const r = await callModel(pick, llm, '只回复两个字：正常', '自检')
      note({ ev: 'llm_selftest_ok', provider: pick.provider, model: pick.model, chars: r.text.length })
    } catch (e) {
      note({ ev: 'llm_selftest_fail', err: String(e).slice(0, 240) })
    }
  }, 8000).unref?.()

  ctx.on('agent/session-start', (ev) => {
      // 新会话开始时顺手同步一次工作区（60 秒节流），避免新工作区的记忆落到 main
      if (Date.now() - lastSyncAt > 60_000) {
        lastSyncAt = Date.now()
        ask({ op: 'sync' }).catch(() => {})
      }
    })
  ctx.on('agent/session-start', ({ agent }) => {
    const id = agent?.session?.header?.id
    if (id) lastInjected.delete(id)
    // 与新出现的 DSH 工作区同步（只增不删），失败不影响对话
    ask({ op: 'sync' }, 5000).then((raw) => {
      if (raw) note({ ev: 'workspace_sync', ok: true })
      projectCache.clear()
    }).catch(() => { /* ignore */ })
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision

    try {
      const sessionId = agent?.session?.header?.id ?? 'unknown'

      // 记忆功能依赖 Python；缺了就明确告诉用户，不要静默失败
      if (!pythonAvailable()) {
        const flag = `${sessionId}:no-python`
        const promptNow = promptOf(decision.messages)
        if (!lastInjected.has(flag) && promptNow && promptNow.length >= MIN_PROMPT) {
          lastInjected.set(flag, true)
          note({ ev: 'no_python_notice' })
          return {
            ...decision,
            messages: [...decision.messages, injectionMessage(
              '（系统提示）长期记忆插件暂时用不了：这台电脑上没有可用的 Python。' +
              '请在插件面板首页按提示安装 Python 3.11+，装好重启 DSH 即可恢复。' +
              '这次对话不会被记住。')],
          }
        }
      }

      const prompt = promptOf(decision.messages)

      if (!prompt || prompt.length < MIN_PROMPT) return decision
      if (prompt.startsWith('/') || prompt.startsWith('[')) return decision
      if (!INJECT_ENABLED) return decision   // 实验/调试：只关注入，其余照常

      const info = await projectInfo(agent)
      const contextText = await recall(prompt, info.project)
      if (contextText.length < 20) {
        note({ ev: 'empty', chars: contextText.length })
        return decision
      }
      if (lastInjected.get(sessionId) === contextText) {
        note({ ev: 'dup' })
        return decision
      }
      lastInjected.set(sessionId, contextText)

      const first = !lastInjected.has(`${sessionId}:banner`)
      lastInjected.set(`${sessionId}:banner`, true)

      const text = compose(contextText, first)
      note({ ev: 'inject', chars: text.length, project: info.project, q: prompt.slice(0, 60) })
      return { ...decision, messages: [...decision.messages, injectionMessage(text)] }
    } catch (e) {
      note({ ev: 'hook_error', err: String(e) })
      return decision
    }
  }, { prepend: true })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!WRITE_ENABLED) return   // 实验/调试：冻结写回，记忆库保持不变
    maybeDistill(ctx, agent)
    drainQueue(ctx).catch(() => { /* 重试失败不影响对话 */ })
    backfillStep(ctx).catch(() => { /* 回填失败不影响对话 */ })
  })
  try { setTimeout(() => backfillStep(ctx).catch(() => {}), 30_000).unref?.() } catch { /* ignore */ }
  // 启动后 20 秒给一次重放机会（上次异常退出留下的队列）
  try { setTimeout(() => drainQueue(ctx).catch(() => {}), 20000).unref?.() } catch { /* ignore */ }
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.header?.id
    if (!id) return
    const st = states.get(id)
    if (st?.timer) clearTimeout(st.timer)
    states.delete(id)
  })

  ctx.effect(() => () => {
    for (const st of states.values()) if (st.timer) clearTimeout(st.timer)
    states.clear()
    killDaemon()
  }, 'mem-auto: daemon')
}

export const inject = []
