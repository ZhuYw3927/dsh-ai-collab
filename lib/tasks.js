/**
 * Pure task-list renderer for the `.ai/` collaboration layer.
 *
 * Why this exists: the plugin used to refresh `TASKS.md` by spawning the
 * workspace's own `.ai/llm.ps1`. That executed code from the repository being
 * worked on, which is a supply-chain risk. Rendering happens here instead:
 * no PowerShell, no workspace-provided script, identical output format.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.js'

/** Parse JSONL text into records, skipping blank or malformed lines. */
export function parseRecords(text) {
  const out = []
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') out.push(value)
    } catch {
      // A malformed line must not stop the list; `ai_check` reports it separately.
    }
  }
  return out
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|')
}

/** Render the exact `TASKS.md` body used by `.ai\llm.cmd tasks`. */
export function renderTasks(records, now) {
  const rows = records.map((r) => ({
    ts: String(r.ts ?? ''),
    action: String(r.action ?? ''),
    status: String(r.status ?? ''),
    summary: cell(r.summary),
    id: String(r.id ?? ''),
  }))
  const lines = [
    '# 任务记录清单',
    '',
    `> 自动生成：来自 \`.ai\\log.jsonl\`，共 ${rows.length} 条；按时间倒序。最后更新 ${now}`,
    '> 只读清单：要新增任务请用 `.ai\\llm.cmd add`，不要直接编辑本文件。',
    '',
    '| 时间 | 类型 | 状态 | 摘要 | 记录 id |',
    '|---|---|---|---|---|',
  ]
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    lines.push(`| ${r.ts} | ${r.action} | ${r.status} | ${r.summary} | \`${r.id}\` |`)
  }
  if (rows.length === 0) lines.push('| （暂无记录） | | | | |')
  return `${lines.join('\n')}\n`
}

/**
 * Write `<root>/TASKS.md` from `<root>/.ai/log.jsonl`.
 * Returns `{ written, count, path }`; never throws by design (caller logs).
 */
export function writeTasks(root, now) {
  const logFile = join(root, '.ai', 'log.jsonl')
  const outFile = join(root, 'TASKS.md')
  if (!existsSync(logFile)) return { written: false, count: 0, path: outFile }
  const records = parseRecords(readFileSync(logFile, 'utf8'))
  mkdirSync(join(root, '.ai'), { recursive: true })
  writeFileAtomic(outFile, renderTasks(records, now))
  return { written: true, count: records.length, path: outFile }
}
