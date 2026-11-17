// 检查 client.js 里用到的每个 t('key') 是否在中英文词典里都有定义
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(dir, '..', 'client.js'), 'utf8')
const zh = src.slice(src.indexOf('      zh: {'), src.indexOf('      en: {'))
const en = src.slice(src.indexOf('      en: {'), src.indexOf('    // ---------- 样式'))

const used = new Set([...src.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]))
const has = (block, key) => new RegExp(`[\\s{,}]${key}\\s*:`).test(block)

const missZh = [...used].filter((k) => !has(zh, k))
const missEn = [...used].filter((k) => !has(en, k))
console.log(`使用中的文案键：${used.size}`)
console.log(`中文缺失：${missZh.length ? missZh.join(', ') : '无'}`)
console.log(`英文缺失：${missEn.length ? missEn.join(', ') : '无'}`)
if (missZh.length || missEn.length) process.exitCode = 1
