#!/usr/bin/env node
// 长期记忆插件安装脚本：把「从 GitHub 装下来就能用」这条链路走通。
//   node install.mjs [--profile desktop] [--workspace <路径>] [--skip-model]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const profile = arg('profile', 'desktop')
const WS = path.resolve(arg('workspace', process.env.LONG_MEMORY_HOME || process.cwd()))
const TOOLS = path.join(WS, 'tools', 'mem')
const VENV = path.join(TOOLS, '.venv')

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
let py = process.env.LONG_MEMORY_PYTHON
if (!py) {
  for (const cand of ['python3', 'python3.12', 'python']) {
    try { execFileSync(cand, ['--version'], { stdio: 'ignore' }); py = cand; break } catch { /* next */ }
  }
}
if (!py) fail('找不到 python3（需要 3.10+）')
ok(py)

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
execFileSync(vpy, [path.join(TOOLS, 'mem.py'), 'index'], { stdio: 'inherit' })
ok('索引完成')

step(6, '注册到 DSH profile')
const profDir = path.join(os.homedir(), '.dsh', 'profiles', profile)
const pkgPath = path.join(profDir, 'package.json')
if (!fs.existsSync(pkgPath)) fail(`找不到 profile：${pkgPath}`)
const d = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
d.dependencies = d.dependencies || {}
d.dependencies['@local/long-memory'] = `link:${path.dirname(fileURLToPath(import.meta.url))}`
const bundles = d.dsh?.profile?.bundles
if (!Array.isArray(bundles)) fail('profile 的 package.json 结构不符合预期')
if (!bundles.includes('@local/long-memory')) bundles.push('@local/long-memory')
fs.writeFileSync(pkgPath, JSON.stringify(d, null, 2) + '\n')
ok(`已写入 ${pkgPath}`)

console.log(`
完成。接下来：
  1. 重启 DeepSeek Harness
  2. 左侧栏应出现「长期记忆」
  3. 若模型没自动识别，设置环境变量 MEM_LLM_PROVIDER / MEM_LLM_MODEL 后再启动
`)
