/**
 * Task-list renderer: reads `.ai/log.jsonl`, writes three-section `.ai/TASKS.md`
 * (markdown archive) + root `TASKS.html` (dashboard-style visual page) +
 * `.ai/PLAN.md` (from .ai/plan.json).
 *
 * 根目录只留用户要读的文件：AGENTS.md 与 HTML 页面；markdown 清单归档在 `.ai/`。
 * Plan-aware rendering is delegated to `lib/plan.js`; this module keeps the
 * record parsing and provides `writeTasks` for index.js.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeAllRenders } from './plan.js'

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

/**
 * Write `.ai/TASKS.md` + `<root>/TASKS.html` + `.ai/PLAN.md`.
 *
 * When `.ai/plan.json` exists the TASKS files include plan/checklist/risks
 * sections before the log table; otherwise they fall back to a log-only view.
 *
 * Returns `{ written, count, tasksMd, tasksHtml, planMd }`;
 * never throws by design (caller logs).
 */
export function writeTasks(root, now, projectName) {
  const logFile = join(root, '.ai', 'log.jsonl')
  const outFile = join(root, '.ai', 'TASKS.md')
  if (!existsSync(logFile)) return { written: false, count: 0, path: outFile }
  const records = parseRecords(readFileSync(logFile, 'utf8'))
  mkdirSync(join(root, '.ai'), { recursive: true })
  const result = writeAllRenders(root, records, now, projectName)
  return { written: true, count: records.length, ...result }
}

// Keep the old `renderTasks` export for test compatibility (deprecated).
export function renderTasks(records, now) {
  const rows = records.map((r) => ({
    ts: String(r.ts ?? ''),
    action: String(r.action ?? ''),
    status: String(r.status ?? ''),
    summary: String(r.summary ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '),
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