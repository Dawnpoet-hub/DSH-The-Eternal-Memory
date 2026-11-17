// Host 侧：给「长期记忆」面板提供本地 HTTP 接口。
// 数据不另存一份，全部来自 tools/mem 的 Python 命令行与 memory/ 里的 Markdown。
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, openSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { zipStore, unzip } from './zip.js'
import { WS, PY, pyNow, CLI, MEM, STATE_DIR, TOOLS, BUNDLE_DIR, pythonAvailable } from './paths.js'

const run = promisify(execFile)

const BACKUPS = path.join(STATE_DIR, 'backups')
const API = '/mem-panel/api'
const CLIENT_VERSION = '3.3.0'
const TOKEN = 'mem-panel-local-v1'
const MAX_BODY = 20 * 1024 * 1024

const pending = new Map() // importId -> { files, plan }

function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

function sendBin(res, status, buf, headers = {}) {
  res.writeHead(status, { 'content-length': buf.length, ...headers })
  res.end(buf)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw new Error('文件太大')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function mem(args) {
  if (!pythonAvailable()) {
    throw new Error('本地记忆引擎还没装好（缺 tools/mem/.venv）。请先运行插件目录下的 install.mjs 完成安装。')
  }
  const { stdout } = await run(pyNow(), [CLI, ...args], { cwd: WS, maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout)
}

const readJsonBody = async (req) => JSON.parse((await readBody(req)).toString('utf8') || '{}')

// ---------- 搬家：打包 ----------

async function walkMd(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkMd(p, base)))
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

function indexable(text) {
  return !/^index:\s*(false|0|no)\s*$/im.test(text.slice(0, 400))
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

async function buildExport() {
  const files = []
  const stamp = new Date()
  const ymd = stamp.toISOString().slice(0, 10)
  const mdFiles = await walkMd(MEM)

  const notes = []
  for (const p of mdFiles) {
    const rel = path.relative(WS, p).split(path.sep).join('/')
    const text = await fs.readFile(p, 'utf8')
    if (!indexable(text)) continue   // 说明类文件（index: false）不进包
    files.push({ name: rel, data: text })
    notes.push({ rel, text })
  }

  // 配置与校验规则：有就带上
  for (const rel of ['mem.json']) {
    const p = path.join(WS, rel)
    if (existsSync(p)) files.push({ name: rel, data: await fs.readFile(p, 'utf8') })
  }

  // 人能直接读的合集
  const all = notes
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map((n) => `\n\n<!-- ${n.rel} -->\n\n${n.text.trim()}`)
    .join('\n')
  files.push({ name: '全部记忆.md', data: `# 我的全部记忆（${ymd}）\n${all}\n` })

  files.push({
    name: '先看我.txt',
    data: [
      '这是一份「长期记忆」备份包。',
      '',
      '怎么用：',
      '1. 在另一台电脑的 DSH 里装好「长期记忆」插件；',
      '2. 打开左侧栏的「长期记忆」；',
      '3. 点「导入记忆包」，选择这个文件。',
      '',
      '不会导入也没关系：直接打开「全部记忆.md」，所有内容都在里面，用记事本就能看。',
      '',
      `导出时间：${stamp.toLocaleString('zh-CN')}`,
      `包含笔记：${notes.length} 篇`,
    ].join('\n'),
  })

  files.push({
    name: 'manifest.json',
    data: JSON.stringify({
      kind: 'dsh-long-memory',
      version: 1,
      exportedAt: stamp.toISOString(),
      noteCount: notes.length,
      notes: notes.map((n) => n.rel),
    }, null, 2),
  })

  return { buffer: zipStore(files), name: `长期记忆-${ymd}.zip`, count: notes.length }
}

// ---------- 搬家：解包与比对 ----------

function pickNoteFiles(zip) {
  const out = []
  for (const [name, buf] of Object.entries(zip)) {
    const m = name.match(/(?:^|\/)memory\/(.+\.md)$/)
    if (m) out.push({ name: m[1], text: buf.toString('utf8') })
  }
  return out
}

async function buildImportPlan(buf) {
  let zip
  try {
    zip = unzip(buf)
  } catch {
    throw new Error('这个文件不是记忆包（无法解读）')
  }
  if (!zip['manifest.json']) throw new Error('这个文件不是记忆包（缺少清单）')

  const incoming = pickNoteFiles(zip)
  if (!incoming.length) throw new Error('这个包里没有记忆内容')

  const local = await walkMd(MEM)
  const localByPath = new Map()
  const localByTitle = new Map()
  for (const p of local) {
    const rel = path.relative(MEM, p).split(path.sep).join('/')
    const text = await fs.readFile(p, 'utf8')
    const title = (text.match(/^title:\s*(.+)$/m)?.[1] ?? path.basename(p, '.md')).trim()
    localByPath.set(rel, { text, title })
    if (!localByTitle.has(title)) localByTitle.set(title, rel)
  }

  const items = incoming.map((n) => {
    const title = (n.text.match(/^title:\s*(.+)$/m)?.[1] ?? n.name.replace(/\.md$/, '')).trim()
    const samePath = localByPath.get(n.name)
    const sameTitleRel = localByTitle.get(title)
    if (samePath && normalize(samePath.text) === normalize(n.text)) {
      return { ...n, title, action: 'same' }
    }
    if (sameTitleRel) {
      const localText = localByPath.get(sameTitleRel)?.text ?? ''
      if (normalize(localText) === normalize(n.text)) return { ...n, title, action: 'same' }
      return { ...n, title, action: 'conflict' }
    }
    return { ...n, title, action: 'fresh' }
  })

  const plan = {
    total: items.length,
    fresh: items.filter((i) => i.action === 'fresh').length,
    same: items.filter((i) => i.action === 'same').length,
    conflict: items.filter((i) => i.action === 'conflict').length,
    items,
  }
  const importId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  pending.set(importId, { items })
  if (pending.size > 5) pending.delete(pending.keys().next().value)
  return { importId, ...plan, items: items.map(({ text, ...rest }) => rest) }
}

function uniqueName(base, taken) {
  let name = base
  let i = 2
  while (taken.has(name)) name = base.replace(/\.md$/, ` ${i++}.md`)
  taken.add(name)
  return name
}

async function commitImport(importId, mode) {
  const entry = pending.get(importId)
  if (!entry) throw new Error('这次导入已过期，请重新选择文件')
  if (mode === 'replace') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dest = path.join(BACKUPS, stamp)
    await fs.mkdir(dest, { recursive: true })
    for (const p of await walkMd(MEM)) {
      const rel = path.relative(MEM, p)
      const target = path.join(dest, rel)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(p, target)
    }
    for (const p of await walkMd(MEM)) await fs.unlink(p)
    for (const it of entry.items) {
      const target = path.join(MEM, it.name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, it.text, 'utf8')
    }
    return { written: entry.items.length, skipped: 0, renamed: 0 }
  }

  // merge：新的写入，冲突改名，相同的跳过
  const taken = new Set((await walkMd(MEM)).map((p) => path.relative(MEM, p).split(path.sep).join('/')))
  let written = 0, skipped = 0, renamed = 0
  const day = new Date().toISOString().slice(0, 10)
  for (const it of entry.items) {
    if (it.action === 'same') { skipped++; continue }
    let name = it.name
    if (it.action === 'conflict' || taken.has(name)) {
      name = uniqueName(it.name.replace(/\.md$/, ` (导入 ${day}).md`), taken)
      renamed++
    } else {
      taken.add(name)
    }
    const target = path.join(MEM, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, it.text, 'utf8')
    written++
  }
  return { written, skipped, renamed }
}

// ---------- 状态 ----------

async function buildStatus() {
  let stats = null
  let list = []
  try { stats = await mem(['stats', '--json']) } catch { /* 索引还没建 */ }
  try { list = await mem(['list', '--json']) } catch { /* 同上 */ }
  const unindexed = list.filter((x) => !x.indexed).length
  const ageHours = stats?.built_at ? (Date.now() / 1000 - stats.built_at) / 3600 : null
  return {
    mcpReady: existsSync(path.join(WS, '.mem/index.db')),
    indexed: Boolean(stats),
    builtAt: stats?.built_at ?? null,
    ageHours,
    unindexed,
    provider: stats?.provider ?? '未安装',
    degraded: typeof stats?.provider === 'string' && stats.provider.startsWith('ngram'),
  }
}


// ---------------- 流水线健康监控 ----------------

function readLog(eventLimit = 4000) {
  try {
    const text = readFileSync(path.join(STATE_DIR, 'auto.log'), 'utf8')
    const lines = text.trim().split('\n').slice(-eventLimit)
    return lines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  } catch { return [] }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(path.join(STATE_DIR, file), 'utf8')) } catch { return fallback }
}

function ago(ts) {
  if (!ts) return null
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.round(s)} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

async function buildPipeline() {
  const log = readLog()
  const events = log.filter((e) => e && e.ev)
  const last = (names) => [...events].reverse().find((e) => names.includes(e.ev))
  const lastDistill = last(['distill'])
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const lastError = [...events].reverse().find((e) =>
    ['distill_error', 'model_try_fail'].includes(e.ev) && e.t >= dayAgo)
  const lastResolved = last(['model_candidates', 'model_resolved'])
  const lastPage = last(['page'])
  const backfill = readJson('backfill.json', { done: {} })
  const queue = readJson('queue.json', [])
  const stateFile = readJson('auto-state.json', { sessions: {} })

  const todayStart = new Date().setHours(0, 0, 0, 0)
  const today = events.filter((e) => e.t >= todayStart)
  const recallToday = today.filter((e) => e.ev === 'inject').length
  const emptyToday = today.filter((e) => e.ev === 'empty').length
  const distillToday = today.filter((e) => e.ev === 'distill').length

  let stats = null
  try { stats = await mem(['stats', '--json']) } catch { /* 引擎没装 */ }

  let mcpReady = false
  try {
    const prof = JSON.parse(readFileSync(path.join(os.homedir(), '.dsh', 'profiles/desktop/package.json'), 'utf8'))
    mcpReady = (prof.dsh?.profile?.bundles ?? []).includes('@local/dsh-the-eternal-memory')
  } catch { /* ignore */ }

  const backfillDone = Object.values(backfill.done ?? {}).filter((v) => v && v.facts).length
  const backfillTotal = 9

  const steps = [
    {
      key: 'engine', title: '本地引擎', sub: '负责搜索和读写记忆的小程序',
      state: pythonAvailable() ? 'ok' : 'fail',
      detail: pythonAvailable() ? 'Python 运行时就绪，检索、索引、导出都靠它' : '这台电脑上没有可用的 Python，记忆的读写暂时不能工作',
      fix: pythonAvailable() ? null : '安装 Python 3.11 或更高版本（python.org），装好后重启插件',
      metric: pythonAvailable() ? '已安装' : '缺失',
    },
    {
      key: 'store', title: '记忆库', sub: '你的笔记文件和它的目录',
      state: !stats ? 'fail' : (stats.notes > 0 ? 'ok' : 'warn'),
      detail: stats ? `共 ${stats.notes} 篇笔记 / ${stats.obs} 条事实 / ${stats.entities} 个实体` : '读不到索引',
      fix: stats ? null : '在面板里点「重新整理」重建索引',
      metric: stats ? `${stats.notes} 篇` : '—',
    },
    {
      key: 'mcp', title: '工具通道', sub: 'AI 直接调取记忆的接口',
      state: mcpReady ? 'ok' : 'warn',
      detail: mcpReady ? '8 个工具已注册，AI 可主动搜索与写入' : '插件未出现在 profile 的 bundle 列表里',
      fix: mcpReady ? null : '检查 profile 的 package.json 里是否有 @local/dsh-the-eternal-memory',
      metric: mcpReady ? '8 个工具' : '未注册',
    },
    {
      key: 'recall', title: '自动召回', sub: '每次提问前，先翻一遍记忆',
      state: today.length && lastResolved ? 'ok' : 'warn',
      detail: `今天注入 ${recallToday} 次，跳过 ${emptyToday} 次（没找到相关内容时主动不打扰）`,
      fix: null,
      metric: recallToday ? `今天 ${recallToday} 次` : '今天还没触发',
    },
    {
      key: 'write', title: '自动写回', sub: '聊完一段，把结论提炼成事实',
      detail: lastDistill
        ? `最近一次 ${ago(lastDistill.t)}：处理 ${lastDistill.fresh ?? '?'} 轮，产出 ${lastDistill.facts} 条事实`
        : '今天还没提炼过',
      fix: queue.length ? `有 ${queue.length} 条待重试（会自动重放）` : null,
      state: lastDistill && (!lastError || lastError.t <= lastDistill.t) ? 'ok'
        : (queue.length ? 'warn' : (lastDistill ? 'warn' : 'idle')),
      metric: queue.length ? `队列 ${queue.length}` : (lastDistill ? ago(lastDistill.t) : '—'),
    },
    {
      key: 'model', title: '模型通道', sub: '写回时用来总结文字的大模型',
      state: lastError && (!lastDistill || lastError.t > lastDistill.t) ? 'warn' : 'ok',
      detail: lastDistill?.provider
        ? `正在用 ${lastDistill.provider} / ${lastDistill.model}`
        : (lastResolved?.list?.[0] ? `候选 ${lastResolved.list[0].provider} / ${lastResolved.list[0].model}` : '还没调用过'),
      fix: (lastError && (!lastDistill || lastError.t > lastDistill.t))
        ? `${lastError.ev}: ${String(lastError.err ?? '').slice(0, 80)}` : null,
      metric: lastDistill?.model ?? '—',
    },
    {
      key: 'pages', title: '主题页面', sub: '把同一主题的结论合成一页',
      state: lastPage ? 'ok' : 'idle',
      detail: lastPage ? `最近重建 ${ago(lastPage.t)}：${lastPage.label}（${lastPage.facts} 条事实）` : '每 10 轮重建一次，还没到',
      fix: null,
      metric: lastPage ? lastPage.label : '未生成',
    },
    {
      key: 'reflect', title: '深推理', sub: '根据现象回溯是哪条决定造成的',
      state: mcpReady ? 'ok' : 'warn',
      detail: '可用：mem_reflect（只在需要时调用，不额外花钱）',
      fix: null,
      metric: mcpReady ? '可用' : '不可用',
    },
    {
      key: 'backfill', title: '历史回填', sub: '把以前的对话补进记忆',
      state: backfillDone >= backfillTotal ? 'ok' : (backfillDone > 0 ? 'idle' : 'warn'),
      detail: `已完成 ${backfillDone} / ${backfillTotal} 个历史会话`,
      fix: null,
      metric: `${backfillDone}/${backfillTotal}`,
    },
  ]

  const bad = steps.filter((s) => s.state === 'fail').length
  const warn = steps.filter((s) => s.state === 'warn').length
  const overall = bad ? 'fail' : (warn ? 'warn' : 'ok')
  return { overall, bad, warn, steps, updatedAt: Date.now() }
}


// ---------------- 详细数据（花费 / 命中率 / 结构） ----------------

const PRICE = { input: 2 / 1e6, output: 8 / 1e6 }   // 元/token，按 deepseek-chat 公开价估算
const CHARS_PER_TOKEN = 0.6                          // 中文估算：1 字符 ≈ 0.6 token

function estimateTokens(chars, facts) {
  const input = Math.round((chars || 0) * CHARS_PER_TOKEN)
  const output = Math.round((facts || 0) * 90 + 150)
  return { input, output, cost: input * PRICE.input + output * PRICE.output }
}

function buildMetrics() {
  const events = readLog(20000).filter((e) => e && e.ev)
  const dayStart = new Date().setHours(0, 0, 0, 0)
  const today = events.filter((e) => e.t >= dayStart)

  const count = (arr, name) => arr.filter((e) => e.ev === name).length
  const inject = count(today, 'inject')
  const skip = count(today, 'empty')
  const distills = today.filter((e) => e.ev === 'distill')

  const distChars = distills.reduce((n, d) => n + (d.chars ?? 0), 0)
  const distFacts = distills.reduce((n, d) => n + (d.facts ?? 0), 0)
  const distWritten = distills.reduce((n, d) => n + (d.written ?? 0), 0)
  const distDup = distills.reduce((n, d) => n + (d.dup ?? 0), 0)
  const avgMs = distills.length
    ? Math.round(distills.reduce((n, d) => n + (d.ms ?? 0), 0) / distills.length) : 0

  const tok = estimateTokens(distChars, distFacts)
  const backfill = readJson('backfill.json', { done: {} })
  const backfillFacts = Object.values(backfill.done ?? {}).reduce((n, v) => n + (v.facts ?? 0), 0)

  // 最近 7 天：召回 / 提炼
  const days = []
  for (let i = 6; i >= 0; i--) {
    const start = new Date().setHours(0, 0, 0, 0) - i * 86400000
    const end = start + 86400000
    const inDay = events.filter((e) => e.t >= start && e.t < end)
    days.push({
      day: new Date(start).toISOString().slice(5, 10),
      inject: inDay.filter((e) => e.ev === 'inject').length,
      distill: inDay.filter((e) => e.ev === 'distill').length,
      facts: inDay.filter((e) => e.ev === 'distill').reduce((n, d) => n + (d.facts ?? 0), 0),
    })
  }

  let edges = { semantic: 0, entity: 0, temporal: 0, causal: 0 }
  let entityKinds = {}
  let totals = { notes: 0, obs: 0, rel: 0 }
  try {
    const db = null
  } catch { /* ignore */ }
  return {
    updatedAt: Date.now(),
    cost: {
      today: Number(tok.cost.toFixed(4)),
      inputTokens: tok.input,
      outputTokens: tok.output,
      chars: distChars,
      priceNote: '按 ¥2/M 输入、¥8/M 输出估算',
    },
    recall: {
      inject, skip,
      hitRate: inject + skip ? Math.round((inject / (inject + skip)) * 100) : null,
      avgChars: inject ? Math.round(today.filter((e) => e.ev === 'inject')
        .reduce((n, e) => n + (e.chars ?? 0), 0) / inject) : 0,
    },
    write: {
      runs: distills.length, facts: distFacts, written: distWritten,
      dup: distDup, avgMs, backfillFacts,
      fallbacks: count(today, 'model_try_fail'),
    },
    days,
  }
}


// ---------------- 活动热力图（类 GitHub 贡献图） ----------------

function buildActivity(days = 365) {
  const events = readLog(20000).filter((e) => e && e.ev === 'distill')
  const byDay = new Map()
  for (const e of events) {
    const d = new Date(e.t)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cur = byDay.get(key) ?? { facts: 0, runs: 0 }
    cur.facts += e.written ?? e.facts ?? 0
    cur.runs += 1
    byDay.set(key, cur)
  }
  const out = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const hit = byDay.get(key)
    out.push({ date: key, dow: d.getDay(), facts: hit?.facts ?? 0, runs: hit?.runs ?? 0 })
  }
  return { days: out, total: out.reduce((n, x) => n + x.facts, 0) }
}


// ---------------- 环境自举：本地部分自动，联网部分交给用户点按钮 ----------------

function sh(cmd, args, timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, { timeout, encoding: 'utf8' })
    return { ok: r.status === 0, out: (r.stdout || r.stderr || '').trim().slice(0, 200) }
  } catch (e) { return { ok: false, out: String(e.message) } }
}

function setupStatus() {
  const toolsOk = existsSync(CLI)
  const py = pyVersion()
  const venv = existsSync(path.join(TOOLS, '.venv'))
  const modelOk = (() => {
    try {
      const dir = path.join(TOOLS, '.fastembed')
      return existsSync(dir) && readdirSync(dir).length > 0
    } catch { return false }
  })()
  const depsOk = (() => {
    if (!py.ok) return false
    for (const cand of [pyNow(), PY, 'python3', 'python']) {
      const r = sh(cand, ['-c', 'import fastembed, numpy'], 8000)
      if (r.ok) return true
    }
    return false
  })()
  return {
    workspace: WS,
    tools: toolsOk,
    python: py,
    deps: depsOk,
    venv,
    model: modelOk,
    needs: [
      ...(toolsOk ? [] : ['tools']),
      ...(py.ok ? [] : ['python']),
      ...(depsOk ? [] : ['deps']),
      ...(modelOk ? [] : ['model']),
    ],
  }
}

function pyVersion() {
  for (const cand of [PY, 'python3', 'python']) {
    const r = sh(cand, ['--version'], 5000)
    if (r.ok) return { ok: true, cmd: cand, version: r.out.replace(/^Python\s*/i, '') }
  }
  return { ok: false, cmd: null, version: null }
}

function runSetupTask(kind) {
  const log = path.join(STATE_DIR, 'setup.log')
  appendFileSync(log, `${JSON.stringify({ t: Date.now(), ev: 'setup_start', kind })}\n`)
  const py = pyVersion()
  if (!py.ok) return { ok: false, error: '没有找到 Python 3，请先安装 Python 3.11+' }

  if (kind === 'deps') {
    // 建 venv（若没有）并安装 requirements
    const venvPy = path.join(TOOLS, '.venv', 'bin', 'python')
    if (!existsSync(venvPy)) {
      const mk = sh(py.cmd, ['-m', 'venv', path.join(TOOLS, '.venv')], 120000)
      if (!mk.ok) return { ok: false, error: '创建虚拟环境失败：' + mk.out }
    }
    const child = spawn(venvPy, ['-m', 'pip', 'install', '-r', ((existsSync(path.join(WS, 'requirements.txt')) ? path.join(WS, 'requirements.txt') : path.join(BUNDLE_DIR, 'requirements.txt')))], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { ok: true, background: true, hint: '正在后台安装依赖，约 1–3 分钟' }
  }

  if (kind === 'model') {
    const cand = existsSync(path.join(TOOLS, '.venv', 'bin', 'python'))
      ? path.join(TOOLS, '.venv', 'bin', 'python') : py.cmd
    const child = spawn(cand, ['-c', 'from fastembed import TextEmbedding; list(TextEmbedding("BAAI/bge-small-zh-v1.5").embed(["warmup"]))'],
      {
        detached: true, stdio: 'ignore', cwd: WS,
        env: { ...process.env, FASTEMBED_CACHE_PATH: path.join(TOOLS, '.fastembed') },
      })
    child.on('error', () => {})
    child.unref()
    return { ok: true, background: true, hint: '正在后台下载向量模型，约 90MB' }
  }
  return { ok: false, error: '未知任务' }
}


// ---------------- 模型管理：随时可切换 ----------------

const DOWNLOADS = new Map()   // model -> { startedAt, expectedGB }

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else { try { total += statSync(full).size } catch { /* ignore */ } }
    }
  }
  return total
}

function modelDir(model) {
  return path.join(TOOLS, '.fastembed', `models--${model.replace('/', '--')}`)
}

function downloadProgress() {
  const out = {}
  for (const [model, info] of DOWNLOADS) {
    // 用「缓存总量增长」而不是模型目录：HuggingFace 先把数据写进 blobs/，
    // 模型目录里只放符号链接，按目录算会一直是 0
    let bytes = 0
    try {
      const total = dirSize(path.join(TOOLS, '.fastembed'))
      bytes = Math.max(0, total - (info.baseline ?? 0))
    } catch { bytes = 0 }
    const expected = Math.max(1, info.expectedGB * 1024 ** 3)
    const pct = Math.min(99, Math.round((bytes / expected) * 100))
    const elapsed = Date.now() - info.startedAt
    // 还没写入任何字节时别假装有进度：前 20 秒显示「准备中」
    const progress = bytes === 0 && elapsed < 20000 ? 0 : Math.max(1, pct)
    out[model] = {
      progress, bytes, expected,
      status: info.status ?? 'running',
      error: info.error ?? null,
      tail: (() => {
        try { return readFileSync(info.log, 'utf8').split('\n').filter(Boolean).slice(-2).join(' ').slice(-160) } catch { return '' }
      })(),
    }
  }
  return out
}

const MODEL_CATALOG = {
  // 只保留 3 档：fastembed 支持 41 个向量模型，其中中文可用的有 7 个，
  // 其余几档（mpnet / MiniLM / potion / jina-v3）要么更弱、要么未实测，不放进界面
  embed: [
    { id: 'BAAI/bge-small-zh-v1.5', gb: 0.09, label: '中文·轻量（默认）', size: '约 90MB · 512维', note: '中文短句够用；速度最快、占用最小，日常首选' },
    { id: 'jinaai/jina-embeddings-v2-base-zh', gb: 0.64, label: '中文·增强', size: '约 640MB · 768维', note: '中文专用长文本模型，语义更细腻，检索更准' },
    { id: 'intfloat/multilingual-e5-large', gb: 2.24, label: '多语言·最强', size: '约 2.2GB · 1024维', note: '检索专用、精度最高；建索引慢、占内存多' },
  ],
  rerank: [
    { id: 'BAAI/bge-reranker-v2-m3-int8', gb: 0.57, label: '精确重排', size: '约 560MB', note: '对候选逐条精算相关性，明显减少「擦边」结果' },
  ],
}

function readMemCfg() {
  try { return JSON.parse(readFileSync(path.join(WS, 'mem.json'), 'utf8')) } catch { return {} }
}

function writeMemCfg(cfg) {
  writeFileSync(path.join(WS, 'mem.json'), JSON.stringify(cfg, null, 2) + '\n')
}

function knownGB(model) {
  const all = [...MODEL_CATALOG.embed, ...MODEL_CATALOG.rerank]
  return all.find((m) => m.id === model)?.gb ?? 0.6
}

function modelCacheHas(model, expectedGB) {
  try {
    const dir = modelDir(model)
    if (!existsSync(dir)) return false
    const want = (expectedGB ?? 0.5) * 1024 ** 3 * 0.85
    return dirSize(dir) >= want
  } catch { return false }
}

function modelStatus() {
  const cfg = readMemCfg()
  const embedCur = cfg.embed?.model || 'BAAI/bge-small-zh-v1.5'
  const rerankCur = cfg.rerank?.model || 'BAAI/bge-reranker-v2-m3-int8'
  return {
    embed: {
      current: embedCur,
      downloaded: modelCacheHas(embedCur, knownGB(embedCur)),
      options: MODEL_CATALOG.embed.map((m) => ({ ...m, active: m.id === embedCur, downloaded: modelCacheHas(m.id, m.gb) })),
    },
    downloads: downloadProgress(),
    rerank: {
      enabled: cfg.rerank?.enabled === true,
      current: rerankCur,
      downloaded: modelCacheHas(rerankCur, knownGB(rerankCur)),
      options: MODEL_CATALOG.rerank.map((m) => ({ ...m, active: m.id === rerankCur, downloaded: modelCacheHas(m.id, m.gb) })),
    },
  }
}

function pyBin() {
  try { const p = pyNow(); return p } catch { return 'python3' }
}

function downloadModel(model, kind) {
  const known = [...MODEL_CATALOG.embed, ...MODEL_CATALOG.rerank].find((m) => m.id === model)
  const logPath = path.join(STATE_DIR, 'model-download.log')
  try { appendFileSync(logPath, `\n[${new Date().toISOString()}] start ${model}\n`) } catch { /* ignore */ }
  let baseline = 0
  try { baseline = dirSize(path.join(TOOLS, '.fastembed')) } catch { baseline = 0 }
  DOWNLOADS.set(model, {
    startedAt: Date.now(), expectedGB: known?.gb ?? 0.6, status: 'running', log: logPath, baseline,
  })

  const cache = path.join(TOOLS, '.fastembed')
  const py = pyBin()
  const lit = JSON.stringify(model)   // 用 JSON 字符串字面量，避免拼接出错
  const script = kind === 'rerank'
    ? `from fastembed.rerank.cross_encoder import TextCrossEncoder as C; list(C(${lit}).rerank("预热", ["记住这件事"]))`
    : `from fastembed import TextEmbedding; list(TextEmbedding(${lit}).embed(["预热"]))`

  let fd = 'ignore'
  try { fd = openSync(logPath, 'a') } catch { fd = 'ignore' }
  const child = spawn(py, ['-c', script], {
    detached: true, stdio: ['ignore', fd, fd], cwd: WS,
    env: { ...process.env, FASTEMBED_CACHE_PATH: cache, PYTHONUNBUFFERED: '1' },
  })
  const entry = DOWNLOADS.get(model)
  child.on('error', (e) => {
    entry.status = 'error'; entry.error = String(e.message)
    try { appendFileSync(logPath, `spawn error: ${e.message}\n`) } catch { /* ignore */ }
  })
  child.on('exit', (code) => {
    if (entry.status === 'error') return
    entry.status = code === 0 ? 'done' : 'error'
    entry.code = code
    try { appendFileSync(logPath, `exit ${code}\n`) } catch { /* ignore */ }
    if (code === 0) setTimeout(() => DOWNLOADS.delete(model), 3000)
  })
  child.unref()
  return { ok: true, background: true, log: logPath }
}

function switchEmbed(model) {
  const cfg = readMemCfg()
  cfg.embed = { ...(cfg.embed || {}), provider: cfg.embed?.provider || 'fastembed', model }
  writeMemCfg(cfg)
  // 换模型必须重建向量：整库重跑
  try {
    spawn(pyBin(), [CLI, 'index'], { cwd: WS, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch { /* ignore */ }
  return { ok: true, reindexing: true, model }
}

function setRerank(enabled) {
  const cfg = readMemCfg()
  cfg.rerank = { enabled: !!enabled, model: cfg.rerank?.model || 'BAAI/bge-reranker-v2-m3-int8', top: cfg.rerank?.top ?? 8 }
  writeMemCfg(cfg)
  return { ok: true, enabled: !!enabled }
}

// ---------- 路由 ----------

function createHandler() {
  return async (req, res) => {
    try {
      if (req.headers['x-mem-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API.length).replace(/^\/+/, '')
      const q = url.searchParams

      const proj = q.get('project')
      const projArgs = proj ? ['--project', proj] : []

      if (req.method === 'GET' && route === 'models') {
        return send(res, 200, modelStatus())
      }
      if (req.method === 'POST' && route === 'models') {
        const body = await readJsonBody(req)
        if (body.action === 'download') return send(res, 200, downloadModel(body.model, body.kind))
        if (body.action === 'setEmbed') return send(res, 200, switchEmbed(body.model))
        if (body.action === 'setRerank') return send(res, 200, setRerank(body.enabled))
        return send(res, 400, { ok: false, error: 'unknown action' })
      }
      if (req.method === 'GET' && route === 'setup') {
        return send(res, 200, setupStatus())
      }
      if (req.method === 'POST' && route === 'setup') {
        const body = await readBody(req)
        return send(res, 200, runSetupTask(body.kind))
      }
      if (req.method === 'GET' && route === 'activity') {
        return send(res, 200, buildActivity())
      }
      if (req.method === 'GET' && route === 'hello') {
        try {
          const stage = url.searchParams.get('stage') || ''
          const err = url.searchParams.get('err') || ''
          appendFileSync(path.join(STATE_DIR, 'auto.log'),
            `${JSON.stringify({ t: Date.now(), ev: 'client_ready', version: CLIENT_VERSION, stage, err })}\n`)
        } catch { /* ignore */ }
        return send(res, 200, { ok: true })
      }
      if (req.method === 'GET' && route === 'metrics') {
        return send(res, 200, buildMetrics())
      }
      if (req.method === 'GET' && route === 'pipeline') {
        return send(res, 200, await buildPipeline())
      }
      if (req.method === 'GET' && route === 'projects') {
        return send(res, 200, await mem(['projects', '--json']))
      }
      if (req.method === 'GET' && route === 'overview') {
        const stats = await mem(['stats', '--json', ...projArgs])
        const events = readLog(4000)
        const lastDistill = [...events].reverse().find((e) => e.ev === 'distill')
        return send(res, 200, {
          ...stats,
          lastDistillAt: lastDistill ? lastDistill.t : null,
          lastDistill: lastDistill
            ? { facts: lastDistill.facts, written: lastDistill.written, ms: lastDistill.ms }
            : null,
        })
      }
      if (req.method === 'GET' && route === 'list') {
        return send(res, 200, await mem(['list', '--json', ...projArgs]))
      }
      if (req.method === 'GET' && route === 'note') {
        const rel = q.get('path')
        const abs = path.resolve(WS, rel)
        if (!abs.startsWith(MEM + path.sep)) return send(res, 400, { error: '路径不合法' })
        if (!existsSync(abs)) return send(res, 404, { error: '这篇笔记不在了' })
        return send(res, 200, { path: rel, content: await fs.readFile(abs, 'utf8') })
      }
      if (req.method === 'PUT' && route === 'note') {
        const body = await readJsonBody(req)
        const abs = path.resolve(WS, body.path)
        if (!abs.startsWith(MEM + path.sep)) return send(res, 400, { error: '路径不合法' })
        await fs.writeFile(abs, body.content, 'utf8')
        mem(['index', '--update', '--json']).catch(() => {})
        return send(res, 200, { ok: true })
      }
      if (req.method === 'DELETE' && route === 'note') {
        const rel = q.get('path')
        const abs = path.resolve(WS, rel)
        if (!abs.startsWith(MEM + path.sep)) return send(res, 400, { error: '路径不合法' })
        const trash = path.join(STATE_DIR, 'trash')
        await fs.mkdir(trash, { recursive: true })
        await fs.rename(abs, path.join(trash, path.basename(abs))).catch(() => {})
        mem(['index', '--update', '--json']).catch(() => {})
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && route === 'reindex') {
        const t0 = Date.now()
        await mem(['index', '--json'])
        return send(res, 200, { ok: true, ms: Date.now() - t0 })
      }
      if (req.method === 'POST' && route === 'search') {
        const body = await readJsonBody(req)
        return send(res, 200, await mem(['search', body.q ?? '', '-n', String(body.limit ?? 8), '--json',
          ...(body.project ? ['--project', body.project] : [])]))
      }
      if (req.method === 'GET' && route === 'status') {
        return send(res, 200, await buildStatus())
      }
      if (req.method === 'GET' && route === 'doctor') {
        return send(res, 200, await mem(['doctor', '--json']))
      }
      if (req.method === 'GET' && route === 'points') {
        return send(res, 200, await mem(['points', '--json']))
      }
      if (req.method === 'GET' && route === 'relations') {
        // 手写的 [[链接]] + 从事实推导的四类边，合并成同一张图
        const [links, edges] = await Promise.all([
          mem(['relations', '--json']),
          mem(['edges', '--json']).catch(() => ({ items: [] })),
        ])
        return send(res, 200, [...(links || []), ...((edges && edges.items) || [])])
      }
      if (req.method === 'GET' && route === 'entities') {
        return send(res, 200, await mem(['edges', '--json']))
      }
      if (req.method === 'GET' && route === 'export') {
        const { buffer, name, count } = await buildExport()
        return sendBin(res, 200, buffer, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="memory-${Date.now()}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'x-note-count': String(count),
        })
      }
      if (req.method === 'POST' && route === 'import/preview') {
        const buf = await readBody(req)
        return send(res, 200, await buildImportPlan(buf))
      }
      if (req.method === 'POST' && route === 'import/commit') {
        const body = await readJsonBody(req)
        const result = await commitImport(body.importId, body.mode ?? 'merge')
        mem(['index', '--json']).catch(() => {})
        return send(res, 200, { ok: true, ...result })
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      return send(res, 500, { error: String(err?.message ?? err) })
    }
  }
}

export function apply(ctx) {
  // 先自举：把包内自带的引擎/schema 铺到工作区，缺目录就建
  try { bootstrapWorkspace(WS) } catch { /* 自举失败不阻塞面板 */ }

  const handler = createHandler()
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API, handler }),
      'mem-panel: api route',
    )
  })
}

export const inject = []

// 便于离线验证（不影响运行时）
export const __test = { createHandler, buildExport, buildImportPlan, commitImport }
