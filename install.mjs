#!/usr/bin/env node
// 长期记忆插件安装脚本：把「从 GitHub 装下来就能用」这条链路走通。
//   node install.mjs [--profile desktop] [--workspace <路径>] [--skip-model]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { bootstrapWorkspace } from './bootstrap.js'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const profile = arg('profile', 'desktop')
const WS = path.resolve(arg('workspace', process.env.LONG_MEMORY_HOME || process.cwd()))
const TOOLS = path.join(WS, 'tools', 'mem')
const VENV = path.join(TOOLS, '.venv')

// 包名从自身 package.json 读，不写死——原来写的是 '@local/long-memory'，
// 和真实包名 '@local/dsh-the-eternal-memory' 不一致，导致 profile 登记失败。
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'package.json'), 'utf8')).name

const step = (n, msg) => console.log(`\n[${n}/6] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const warn = (msg) => console.log(`  ⚠ ${msg}`)
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exit(1) }

step(1, '检查工作区')
if (!fs.existsSync(path.join(TOOLS, 'mem.py'))) {
  fail(`在 ${TOOLS} 找不到 mem.py。请把 tools/mem 一起放到工作区，或用 --workspace 指定。`)
}
ok(WS)

step(2, '检查 Python')
// 与运行时一致：优先用 DSH 自带的 Python（README 承诺「Python 不用自己装」），
// 找不到再退回系统的 python3。原来只找系统 Python，没装的人这一步就会失败。
function findDshPython() {
  for (const root of [path.join(os.homedir(), '.dsh', 'dsh-runtimes'), path.join(os.homedir(), '.dsh', 'runtimes')]) {
    if (!fs.existsSync(root)) continue
    for (const rt of fs.readdirSync(root)) {
      const bin = path.join(root, rt, 'dependencies', 'python', 'bin')
      if (!fs.existsSync(bin)) continue
      const cand = fs.readdirSync(bin).filter((f) => /^python3(\.\d+)?$/.test(f)).sort().pop()
      if (cand) return path.join(bin, cand)
    }
  }
  return null
}
let py = process.env.LONG_MEMORY_PYTHON
if (!py) {
  const dshPy = findDshPython()
  if (dshPy) { py = dshPy; ok(`用 DSH 自带的 Python：${dshPy}`) }
}
if (!py) {
  for (const cand of ['python3', 'python3.12', 'python3.11', 'python']) {
    try { execFileSync(cand, ['--version'], { stdio: 'ignore' }); py = cand; break } catch { /* next */ }
  }
  if (py) ok(`用系统 Python：${py}`)
}
if (!py) fail('找不到 Python 3.10+。DSH 桌面版通常自带一个；若没有，请装 python.org 的 3.11+ 后重跑本脚本。')

step(3, '创建虚拟环境')
if (!fs.existsSync(path.join(VENV, 'bin', 'python'))) {
  execFileSync(py, ['-m', 'venv', VENV], { stdio: 'inherit' })
  ok('已创建 tools/mem/.venv')
} else ok('已存在，跳过')

step(4, '安装依赖（fastembed 等）')
const vpy = path.join(VENV, 'bin', 'python')
const req = path.join(TOOLS, 'requirements.txt')
if (fs.existsSync(req)) {
  execFileSync(vpy, ['-m', 'pip', 'install', '-q', '-r', req], { stdio: 'inherit' })
} else {
  execFileSync(vpy, ['-m', 'pip', 'install', '-q', 'fastembed'], { stdio: 'inherit' })
}
ok('依赖就绪')

step(5, '初始化索引')
// 先铺工作区：memory/、.mem/、schemas/、mem.json 都由 bootstrapWorkspace 建。
// 少了 .mem/，mem.py 写锁文件会直接 FileNotFoundError（原来就死在这一步）。
try {
  const r = bootstrapWorkspace(WS)
  ok(`工作区已就绪${r.prepared.length ? '：新建 ' + r.prepared.join('、') : ''}`)
} catch (e) {
  fail(`铺工作区失败：${e.message}`)
}
execFileSync(vpy, [path.join(TOOLS, 'mem.py'), 'index'], { stdio: 'inherit' })
ok('索引完成')

step(6, '注册到 DSH profile')
const profDir = path.join(os.homedir(), '.dsh', 'profiles', profile)
const pkgPath = path.join(profDir, 'package.json')
if (!fs.existsSync(pkgPath)) fail(`找不到 profile：${pkgPath}`)
const d = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
d.dependencies = d.dependencies || {}
d.dependencies[PKG_NAME] = `link:${SELF_DIR}`
const bundles = d.dsh?.profile?.bundles
if (!Array.isArray(bundles)) fail('profile 的 package.json 结构不符合预期')
if (!bundles.includes(PKG_NAME)) bundles.push(PKG_NAME)
fs.writeFileSync(pkgPath, JSON.stringify(d, null, 2) + '\n')
ok(`已写入 ${pkgPath}（依赖名 ${PKG_NAME}）`)

// 补建 node_modules 软链：某些情况下 DSH 不会自动装 link: 依赖，
// 缺了它启动时找不到 bundle（表现为侧边栏没有「长期记忆」）。
const scope = PKG_NAME.startsWith('@') ? PKG_NAME.split('/')[0] : null
const dirName = PKG_NAME.startsWith('@') ? PKG_NAME.split('/')[1] : PKG_NAME
const linkDir = scope ? path.join(profDir, 'node_modules', scope) : path.join(profDir, 'node_modules')
const linkPath = path.join(linkDir, dirName)
try {
  fs.mkdirSync(linkDir, { recursive: true })
  try { fs.unlinkSync(linkPath) } catch { /* 不存在就算了 */ }
  fs.symlinkSync(SELF_DIR, linkPath, 'dir')
  ok(`已建立 ${linkPath}`)
} catch (e) {
  warn(`软链没建成（${e.message}）——如果重启后侧边栏没有入口，手动创建这个链接：ln -sfn ${SELF_DIR} ${linkPath}`)
}

console.log(`
完成。接下来：
  1. 重启 DeepSeek Harness
  2. 左侧栏应出现「长期记忆」
  3. 若模型没自动识别，设置环境变量 MEM_LLM_PROVIDER / MEM_LLM_MODEL 后再启动
`)
