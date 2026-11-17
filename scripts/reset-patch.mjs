// 发布前跑一次：把本机绝对路径换回占位符，避免把个人路径提交到仓库
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.resolve(dir, '..')
const patchPath = path.join(bundle, 'cordis.patch.yml')
const ws = process.env.LONG_MEMORY_HOME || path.resolve(bundle, '..', '..')

let text = fs.readFileSync(patchPath, 'utf8')
text = text
  .replaceAll(`${ws}/tools/mem/.venv/bin/python`, '__LM_PY__')
  .replaceAll(`${ws}/tools/mem/.venv/Scripts/python.exe`, '__LM_PY__')
  .replaceAll(`${ws}/tools/mem/mcp_server.py`, '__LM_MCP_SERVER__')
  .replaceAll(`cwd: ${ws}`, 'cwd: __LM_WS__')
fs.writeFileSync(patchPath, text)
console.log('占位符剩余:', (text.match(/__LM_/g) || []).length)
