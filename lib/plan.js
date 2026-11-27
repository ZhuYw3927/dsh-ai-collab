/**
 * `ai_plan` data layer: `.ai/plan.json` (structured plan/checklist/risks)
 * and its rendered outputs `.ai/PLAN.md` and `.ai/TASKS.md` (three-section,
 * markdown archive) + `TASKS.html` (project-root visual page).
 *
 * plan.json 写入走原子写 + 项目级锁（与 appendRecord 同级保护）。
 * 渲染产物（.ai/TASKS.md / .ai/PLAN.md / TASKS.html）不手改：根目录只留
 * 用户要读的 AGENTS.md 与 HTML 页面，markdown 清单归 `.ai/`。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, readText } from './atomic.js'
import { withLock } from './lock.js'

// ---------------------------------------------------------------- schema

export const PLAN_STATUSES = ['todo', 'in_progress', 'done', 'blocked']
export const CHECKLIST_STATUSES = ['open', 'done', 'na']
export const RISK_PROBABILITIES = ['高', '中', '低']
export const RISK_IMPACTS = ['高', '中', '低']
export const RISK_STRATEGIES = ['规避', '减轻', '接受', '转移']
export const RISK_STATUSES = ['active', 'resolved', 'expired']

/** 新建空 plan 的默认值。 */
export function emptyPlan() {
  return {
    schema_version: 1,
    updated_at: '',
    plan: [],
    checklist: [],
    risks: [],
  }
}

// ---------------------------------------------------------------- paths

function planPath(root) { return join(root, '.ai', 'plan.json') }
function planMdPath(root) { return join(root, '.ai', 'PLAN.md') }
function tasksMdPath(root) { return join(root, '.ai', 'TASKS.md') }

/** 需要锁保护的动作统一走这里。 */
function planLockPath(root) { return join(root, '.ai', '.plan.lock') }

// ---------------------------------------------------------------- read / write

export function readPlan(root) {
  try {
    const raw = readText(planPath(root))
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return emptyPlan()
    const p = emptyPlan()
    if (Array.isArray(obj.plan)) p.plan = obj.plan
    if (Array.isArray(obj.checklist)) p.checklist = obj.checklist
    if (Array.isArray(obj.risks)) p.risks = obj.risks
    if (typeof obj.schema_version === 'number') p.schema_version = obj.schema_version
    if (typeof obj.updated_at === 'string') p.updated_at = obj.updated_at
    return p
  } catch {
    return emptyPlan()
  }
}

export function writePlan(root, plan, now) {
  mkdirSync(join(root, '.ai'), { recursive: true })
  const payload = { ...plan, updated_at: now || new Date().toISOString() }
  return withLock(planLockPath(root), () => {
    writeFileAtomic(planPath(root), JSON.stringify(payload, null, 2) + '\n')
    writeFileAtomic(planMdPath(root), renderPlanMarkdown(payload))
    return payload
  })
}

// ---------------------------------------------------------------- setters

/** 用一组项覆盖 plan/checklist/risks 中的一块。 */
export function setBlock(root, key, items, now) {
  const plan = readPlan(root)
  if (!['plan', 'checklist', 'risks'].includes(key)) throw new Error(`未知块: ${key}`)
  if (!Array.isArray(items)) throw new Error(`${key} 必须为数组`)
  plan[key] = items
  return writePlan(root, plan, now)
}

/** 勾选清单项。返回更新后的 plan 与该项。 */
export function doneChecklistItem(root, id, now) {
  const plan = readPlan(root)
  const target = plan.checklist.find((c) => c.id === id)
  if (!target) throw new Error(`清单项不存在: ${id}`)
  target.status = 'done'
  return { plan: writePlan(root, plan, now), item: target }
}

/** 收集当前 active 风险标题（用于联动 status.json.blockers）。 */
export function activeRiskTitles(plan) {
  return (plan.risks || [])
    .filter((r) => r.status === 'active')
    .map((r) => r.risk)
}

// ---------------------------------------------------------------- render: PLAN.md

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function statusLabel(status) {
  const map = { todo: '待办', in_progress: '进行中', done: '完成', blocked: '阻塞',
    open: '待办', na: '不适用', active: '活跃', resolved: '已解决', expired: '已失效' }
  return map[status] || status
}

export function renderPlanMarkdown(plan) {
  const lines = [
    '# 执行计划与清单',
    '',
    `> 自动生成：来源 \`.ai\\plan.json\`。最后更新 ${plan.updated_at || '—'}`,
    '> 用工具 `ai_plan` 管理，不要手动编辑本文件。',
    '',
  ]

  if ((plan.plan || []).length > 0) {
    lines.push('## 执行计划', '')
    lines.push('| # | 步骤 | 验收标准 | 状态 | 负责人 | 截止 |')
    lines.push('|---|---|---|---|---|---|')
    for (const p of plan.plan) {
      lines.push(`| ${cell(p.id)} | ${cell(p.step)} | ${cell(p.acceptance)} | ${statusLabel(p.status)} | ${cell(p.owner)} | ${cell(p.due)} |`)
    }
    lines.push('')
  }

  if ((plan.checklist || []).length > 0) {
    lines.push('## 检查清单', '')
    lines.push('| # | 项 | 状态 | 关联记录 |')
    lines.push('|---|---|---|---|')
    for (const c of plan.checklist) {
      lines.push(`| ${cell(c.id)} | ${cell(c.item)} | ${statusLabel(c.status)} | ${cell(c.link)} |`)
    }
    lines.push('')
  }

  if ((plan.risks || []).length > 0) {
    lines.push('## 风险与应对', '')
    lines.push('| 风险 | 概率 | 影响 | 策略 | 状态 |')
    lines.push('|---|---|---|---|---|')
    for (const r of plan.risks) {
      lines.push(`| ${cell(r.risk)} | ${cell(r.probability)} | ${cell(r.impact)} | ${cell(r.strategy)} | ${statusLabel(r.status)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------- render: TASKS.md (three-section)

export function renderTasksMarkdown(root, records, plan, now) {
  const lines = [
    '# 任务记录清单',
    '',
    `> 自动生成：来自 \`.ai\\log.jsonl\`，共 ${records.length} 条；按时间倒序。最后更新 ${now}`,
    '> 只读清单：要新增记录请用 `.ai\\llm.cmd add` 或工具 `ai_log`，不要直接编辑本文件。',
    '',
  ]

  // --- plan sections ---
  if (plan && plan.plan.length > 0) {
    lines.push('## 执行计划（来源：`.ai\\plan.json`）', '')
    lines.push('| # | 步骤 | 验收标准 | 状态 | 负责人 | 截止 |')
    lines.push('|---|---|---|---|---|---|')
    for (const p of plan.plan) {
      lines.push(`| ${cell(p.id)} | ${cell(p.step)} | ${cell(p.acceptance)} | ${statusLabel(p.status)} | ${cell(p.owner)} | ${cell(p.due)} |`)
    }
    lines.push('')
  }

  if (plan && plan.checklist.length > 0) {
    lines.push('## 检查清单（来源：`.ai\\plan.json`）', '')
    lines.push('| # | 项 | 状态 | 关联记录 |')
    lines.push('|---|---|---|---|')
    for (const c of plan.checklist) {
      lines.push(`| ${cell(c.id)} | ${cell(c.item)} | ${statusLabel(c.status)} | ${cell(c.link)} |`)
    }
    lines.push('')
  }

  if (plan && plan.risks.length > 0) {
    lines.push('## 风险与应对（来源：`.ai\\plan.json`）', '')
    lines.push('| 风险 | 概率 | 影响 | 策略 | 状态 |')
    lines.push('|---|---|---|---|---|')
    for (const r of plan.risks) {
      lines.push(`| ${cell(r.risk)} | ${cell(r.probability)} | ${cell(r.impact)} | ${cell(r.strategy)} | ${statusLabel(r.status)} |`)
    }
    lines.push('')
  }

  // --- log records ---
  lines.push('## 工作日志（来源：`.ai\\log.jsonl`，只读）', '')
  lines.push('| 时间 | 类型 | 状态 | 摘要 | 记录 id |')
  lines.push('|---|---|---|---|---|')
  const rows = records.map((r) => ({
    ts: String(r.ts ?? ''),
    action: String(r.action ?? ''),
    status: String(r.status ?? ''),
    summary: cell(r.summary),
    id: String(r.id ?? ''),
  }))
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    lines.push(`| ${r.ts} | ${r.action} | ${r.status} | ${r.summary} | \`${r.id}\` |`)
  }
  if (rows.length === 0) lines.push('| （暂无记录） | | | | |')
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------- render: TASKS.html (dashboard-style)

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function riskColor(p, i) {
  // 高/高 → 红；高/中 或 中/高 → 橙；中/中 → 黄；其余 → 灰
  if (p === '高' && i === '高') return '#dc3545'
  if ((p === '高' && i === '中') || (p === '中' && i === '高')) return '#fd7e14'
  if (p === '中' && i === '中') return '#ffc107'
  return '#6c757d'
}

function statusBadge(status) {
  const colors = { todo: '#6c757d', in_progress: '#0d6efd', done: '#198754', blocked: '#dc3545',
    open: '#6c757d', na: '#adb5bd', active: '#dc3545', resolved: '#198754', expired: '#adb5bd' }
  return `<span style="background:${colors[status] || '#6c757d'};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${htmlEsc(statusLabel(status))}</span>`
}

export function renderTasksHtml(root, records, plan, now, projectName) {
  const name = htmlEsc(projectName || root.split(/[/\\]/).filter(Boolean).pop() || '')
  const recordRows = records.map((r) => ({
    ts: String(r.ts ?? ''),
    action: String(r.action ?? ''),
    status: String(r.status ?? ''),
    summary: htmlEsc(r.summary),
    id: htmlEsc(r.id ?? ''),
  })).reverse()

  let planHtml = ''
  if (plan && plan.plan.length > 0) {
    planHtml += '<section><h2>📋 执行计划</h2><table><tr><th>#</th><th>步骤</th><th>验收标准</th><th>状态</th><th>负责人</th><th>截止</th></tr>'
    for (const p of plan.plan) {
      planHtml += `<tr><td>${htmlEsc(p.id)}</td><td>${htmlEsc(p.step)}</td><td>${htmlEsc(p.acceptance)}</td><td>${statusBadge(p.status)}</td><td>${htmlEsc(p.owner)}</td><td>${htmlEsc(p.due)}</td></tr>`
    }
    planHtml += '</table></section>'
  }

  let checklistHtml = ''
  if (plan && plan.checklist.length > 0) {
    checklistHtml += '<section><h2>✅ 检查清单</h2><table><tr><th>#</th><th>项</th><th>状态</th><th>关联记录</th></tr>'
    for (const c of plan.checklist) {
      checklistHtml += `<tr><td>${htmlEsc(c.id)}</td><td>${htmlEsc(c.item)}</td><td>${statusBadge(c.status)}</td><td>${htmlEsc(c.link)}</td></tr>`
    }
    checklistHtml += '</table></section>'
  }

  let risksHtml = ''
  if (plan && plan.risks.length > 0) {
    risksHtml += '<section><h2>⚠️ 风险与应对</h2><table><tr><th>风险</th><th>概率</th><th>影响</th><th>策略</th><th>状态</th></tr>'
    for (const r of plan.risks) {
      const dot = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${riskColor(r.probability, r.impact)};margin-right:4px"></span>`
      risksHtml += `<tr><td>${dot}${htmlEsc(r.risk)}</td><td>${htmlEsc(r.probability)}</td><td>${htmlEsc(r.impact)}</td><td>${htmlEsc(r.strategy)}</td><td>${statusBadge(r.status)}</td></tr>`
    }
    risksHtml += '</table></section>'
  }

  let logHtml = ''
  if (recordRows.length > 0) {
    logHtml += '<section><h2>📜 工作日志</h2><table><tr><th>时间</th><th>类型</th><th>状态</th><th>摘要</th><th>记录 id</th></tr>'
    for (const r of recordRows) {
      logHtml += `<tr><td>${htmlEsc(r.ts)}</td><td>${htmlEsc(r.action)}</td><td>${statusBadge(r.status)}</td><td>${r.summary}</td><td><code>${r.id}</code></td></tr>`
    }
    logHtml += '</table></section>'
  }

  const hasPlan = plan && (plan.plan.length > 0 || plan.checklist.length > 0 || plan.risks.length > 0)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${name} · 任务清单</title>
<style>
:root { --bg:#f8f9fa; --card:#fff; --text:#212529; --muted:#6c757d; --border:#dee2e6; font-family:system-ui,-apple-system,sans-serif; }
body { background:var(--bg); color:var(--text); margin:0; padding:16px; }
.container { max-width:960px; margin:0 auto; }
header { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px 24px; margin-bottom:16px; }
header h1 { margin:0 0 4px; font-size:20px; }
header .meta { color:var(--muted); font-size:13px; }
section { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px 24px; margin-bottom:16px; }
section h2 { margin:0 0 12px; font-size:16px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
th { background:#f1f3f5; font-weight:600; white-space:nowrap; }
tr:hover { background:#f8f9fa; }
.placeholder { color:var(--muted); font-style:italic; padding:12px 0; }
footer { text-align:center; color:var(--muted); font-size:12px; padding:12px; }
</style>
</head>
<body>
<div class="container">
<header>
  <h1>${name} · 任务清单</h1>
  <div class="meta">${hasPlan ? `计划更新: ${htmlEsc(plan.updated_at || '—')} · ` : ''}日志共 ${records.length} 条 · 生成: ${htmlEsc(now)}</div>
</header>
${planHtml}${checklistHtml}${risksHtml}${logHtml}
${records.length === 0 && !hasPlan ? '<div class="placeholder">暂无记录与计划。</div>' : ''}
<footer>自动生成 · 来源 .ai/log.jsonl + .ai/plan.json · 勿手动编辑</footer>
</div>
</body>
</html>
`
}

// ---------------------------------------------------------------- write all renders

/** 一次写 .ai/TASKS.md + TASKS.html + .ai/PLAN.md（在锁内）。 */
export function writeAllRenders(root, records, now, projectName) {
  mkdirSync(join(root, '.ai'), { recursive: true })
  const plan = readPlan(root)
  return withLock(planLockPath(root), () => {
    writeFileAtomic(tasksMdPath(root), renderTasksMarkdown(root, records, plan, now))
    writeFileAtomic(join(root, 'TASKS.html'), renderTasksHtml(root, records, plan, now, projectName))
    writeFileAtomic(planMdPath(root), renderPlanMarkdown(plan))
    return { plan, tasksMd: tasksMdPath(root), tasksHtml: join(root, 'TASKS.html'), planMd: planMdPath(root) }
  })
}