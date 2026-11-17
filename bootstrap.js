// 自举：把插件包里自带的东西铺到工作区，保证「装了插件就能找到引擎」
// 只做本地复制/建目录，不联网、不下载——需要联网的部分交给 /setup 接口由用户点按钮触发。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function hasTools(base) {
  try { return fs.existsSync(path.join(base, 'tools', 'mem', 'mem.py')) } catch { return false }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // 不复制虚拟环境与模型缓存，它们要么该重新生成，要么体积大
    if (entry.name === '.venv' || entry.name === '.fastembed' || entry.name === '__pycache__') continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/**
 * @param {string} ws 目标工作区
 * @returns {{ prepared: string[], skipped: string[] }}
 */
/**
 * MCP 通道的启动命令必须是绝对路径（MCP 客户端不做变量展开），
 * 所以把 patch 里的占位符换成这台机器上的真实路径。幂等。
 */
export function fillMcpPatch(ws) {
  const patchPath = path.join(HERE, 'cordis.patch.yml')
  try {
    let text = fs.readFileSync(patchPath, 'utf8')
    const py = path.join(ws, 'tools', 'mem', '.venv', 'bin', 'python')
    const pyWin = path.join(ws, 'tools', 'mem', '.venv', 'Scripts', 'python.exe')
    const interp = fs.existsSync(py) ? py : fs.existsSync(pyWin) ? pyWin : 'python3'
    const before = text
    text = text
      .replaceAll('__LM_PY__', interp)
      .replaceAll('__LM_MCP_SERVER__', path.join(ws, 'tools', 'mem', 'mcp_server.py'))
      .replaceAll('__LM_WS__', ws)
      // 已填过的文件也要能更新：装了依赖之后把解释器从 python3 换成 venv 里的
      .replace(/^(\s*command:\s*).*$/m, `$1${interp}`)
      .replace(/^(\s*-\s*).*mcp_server\.py\s*$/m, `$1${path.join(ws, 'tools', 'mem', 'mcp_server.py')}`)
      .replace(/^(\s*cwd:\s*).*$/m, `$1${ws}`)
    if (text === before) return { changed: false, interp }
    fs.writeFileSync(patchPath, text)
    return { changed: true, interp }
  } catch (e) {
    return { changed: false, error: String(e.message) }
  }
}

export function bootstrapWorkspace(ws) {
  const prepared = []
  const skipped = []

  // 1) 必备目录
  for (const dir of ['memory', '.mem']) {
    const p = path.join(ws, dir)
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); prepared.push(dir) }
    else skipped.push(dir)
  }

  // 2) Python 引擎：工作区没有就从包里铺一份
  if (!hasTools(ws)) {
    const src = path.join(HERE, 'tools')
    if (fs.existsSync(src)) {
      copyDir(src, path.join(ws, 'tools'))
      prepared.push('tools/')
    }
  } else skipped.push('tools/')

  // 3) schema 与项目配置
  const schemasSrc = path.join(HERE, 'schemas')
  if (fs.existsSync(schemasSrc)) {
    const dst = path.join(ws, 'schemas')
    if (!fs.existsSync(dst)) { copyDir(schemasSrc, dst); prepared.push('schemas/') }
    else skipped.push('schemas/')
  }
  const memJson = path.join(ws, 'mem.json')
  if (!fs.existsSync(memJson)) {
    const tpl = path.join(HERE, 'mem.template.json')
    if (fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, memJson)
      prepared.push('mem.json')
    }
  } else skipped.push('mem.json')

  return { prepared, skipped }
}
