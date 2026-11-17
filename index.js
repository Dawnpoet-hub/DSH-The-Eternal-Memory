// 长期记忆：一个插件，三层能力
//   ① 面板（可视化查看/搜索/搬家）
//   ② 自动召回与写回（宿主钩子）
//   ③ MCP 工具（由 cordis.patch.yml 里的 dsh-mcp-client 条目提供）
// 拆成三个 bundle 会让插件页出现三张卡片和三个开关，所以这里是合并后的唯一入口。
import fs from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from './paths.js'
import { WS } from './paths.js'
import { bootstrapWorkspace, fillMcpPatch } from './bootstrap.js'
import { apply as applyPanel } from './panel-host.js'
import { apply as applyAuto } from './auto.js'

function logApply(part, err) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(path.join(STATE_DIR, 'auto.log'),
      `${JSON.stringify({ t: Date.now(), ev: 'apply_error', part, err: String(err).slice(0, 300) })}\n`)
  } catch { /* ignore */ }
}

export function apply(ctx) {
  // 首次安装时把工作区铺好，并把 patch 里的路径占位符换成本机真实路径
  try {
    bootstrapWorkspace(WS)
    fillMcpPatch(WS)
  } catch { /* 自举失败不影响其它能力 */ }

  // 任何一半失败都不能连累另一半：面板挂了，自动召回仍然工作，反之亦然
  try { applyPanel(ctx) } catch (e) { logApply('panel', e) }
  try { applyAuto(ctx) } catch (e) { logApply('auto', e) }
}

export const inject = []
