// 路径解析：不再写死任何绝对路径。
// 优先级：环境变量 > 从插件自身位置推导 > 当前工作目录。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLE_DIR = HERE

function hasTools(base) {
  try { return fs.existsSync(path.join(base, 'tools', 'mem', 'mem.py')) } catch { return false }
}

function resolveWorkspace() {
  const env = process.env.LONG_MEMORY_HOME
  if (env && fs.existsSync(env)) return path.resolve(env)
  // 开发布局：<workspace>/dsh-bundles/long-memory/
  const up2 = path.resolve(HERE, '..', '..')
  if (hasTools(up2)) return up2
  // 安装后：插件在 profile/node_modules 里，工作区一般就是启动目录
  for (const cand of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    // 不要把插件自身目录当成工作区（否则 memory/ 会落在仓库里）
    if (path.resolve(cand) === path.resolve(HERE)) continue
    if (hasTools(cand)) return cand
  }
  // 兜底：没有既有工作区时，落到一个稳定、可写、可预期的地方，
  // 而不是把 memory/ 建在 /tmp 或应用目录里
  return path.join(os.homedir(), '.dsh', 'long-memory')
}

export const WS = resolveWorkspace()
export const TOOLS = path.join(WS, 'tools', 'mem')
// 找 DSH 自带的 Python 运行时（桌面版会随运行时装一份 3.12）
function findDshPython() {
  try {
    const roots = [
      path.join(os.homedir(), '.dsh', 'dsh-runtimes'),
      path.join(os.homedir(), '.dsh', 'runtimes'),
    ]
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      for (const rt of fs.readdirSync(root)) {
        const bin = path.join(root, rt, 'dependencies', 'python', 'bin')
        if (!fs.existsSync(bin)) continue
        const cand = fs.readdirSync(bin).filter((f) => /^python3(\.\d+)?$/.test(f)).sort().pop()
        if (cand) return path.join(bin, cand)
      }
    }
  } catch { /* ignore */ }
  return null
}

const DSH_PY = findDshPython()

// Python 解释器优先级：显式环境变量 > 插件自带 venv > DSH 自带运行时 > 系统 python3
function resolvePython() {
  if (process.env.LONG_MEMORY_PYTHON) return process.env.LONG_MEMORY_PYTHON
  const venvPy = path.join(TOOLS, '.venv', 'bin', 'python')
  try { if (fs.existsSync(venvPy)) return venvPy } catch { /* ignore */ }
  const venvPyWin = path.join(TOOLS, '.venv', 'Scripts', 'python.exe')
  try { if (fs.existsSync(venvPyWin)) return venvPyWin } catch { /* ignore */ }
  if (DSH_PY) return DSH_PY
  return 'python3'
}

export const PY = resolvePython()
// 每次真正调用时再算一次：装完依赖/新建 venv 后无需重启就能用上
export const pyNow = () => {
  try {
    const venv = path.join(TOOLS, '.venv', 'bin', 'python')
    if (fs.existsSync(venv)) return venv
    const win = path.join(TOOLS, '.venv', 'Scripts', 'python.exe')
    if (fs.existsSync(win)) return win
  } catch { /* ignore */ }
  return process.env.LONG_MEMORY_PYTHON || 'python3'
}
export const CLI = path.join(TOOLS, 'mem.py')
export const SERVE = path.join(TOOLS, 'serve.py')
export const MEM = path.join(WS, 'memory')
export const STATE_DIR = path.join(WS, '.mem')

export const paths = { WS, TOOLS, PY, CLI, SERVE, MEM, STATE_DIR }

// 真的去探一次：绝对路径看文件在不在，命令名看能不能跑起来
let pyProbe = null
export function pythonAvailable() {
  if (pyProbe !== null) return pyProbe
  const tryCmd = (cmd) => {
    try { return spawnSync(cmd, ['--version'], { timeout: 4000 }).status === 0 } catch { return false }
  }
  if (PY !== 'python3') pyProbe = fs.existsSync(PY) || tryCmd(PY)
  else pyProbe = tryCmd('python3') || tryCmd('python')
  return pyProbe
}

export const VENV_PY = path.join(TOOLS, '.venv', 'bin', 'python')
