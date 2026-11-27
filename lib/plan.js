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

// ---------------------------------------------------------------- render: TASKS.html (dark log page)

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const TYPE_CLASS = {
  task_done: 'tag tag-task_done', task_start: 'tag tag-task_start', fix: 'tag tag-fix',
  doc: 'tag tag-doc', build: 'tag tag-build', maintenance: 'tag tag-maintenance',
  diagnosis: 'tag tag-diagnosis', review: 'tag tag-review', commit: 'tag tag-commit',
  rollback: 'tag tag-rollback', correction: 'tag tag-correction', handoff: 'tag tag-handoff',
}

function typeClass(action) {
  const a = String(action ?? '').trim().toLowerCase()
  return TYPE_CLASS[a] || 'tag'
}

function riskColor(probability, impact) {
  // 高/高 → 红；高/中 或 中/高 → 橙；中/中 → 黄；其余 → 灰
  if (probability === '高' && impact === '高') return '#f87171'
  if ((probability === '高' && impact === '中') || (probability === '中' && impact === '高')) return '#fb923c'
  if (probability === '中' && impact === '中') return '#fbbf24'
  return '#94a3b8'
}

function statusLevel(status) {  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'ok') return 'ok'
  if (s === 'partial') return 'partial'
  if (s === 'todo' || s === 'blocked') return 'todo'
  return 'other'
}

function stClass(status) {
  return `st st-${statusLevel(status)}`
}

// 通用「表格 → 窄窗卡片」渲染：列定义 + 单元格 HTML
function cardTable(cols, rows) {
  const colsHtml = cols.map((c) => (c.width ? `<col style="width:${c.width}">` : '<col>')).join('')
  const headHtml = cols.map((c) => `<th scope="col">${htmlEsc(c.label)}</th>`).join('')
  const body = rows.map((cells) => '<tr class="row">'
    + cells.map((cell, i) => `<td data-label="${htmlEsc(cols[i].label)}"${cols[i].cls ? ` class="${cols[i].cls}"` : ''}>${cell}</td>`).join('')
    + '</tr>').join('\n')
  return `<div class="table-wrap"><table><colgroup>${colsHtml}</colgroup>`
    + `<thead><tr>${headHtml}</tr></thead><tbody>${body}</tbody></table></div>`
}

export function renderTasksHtml(root, records, plan, now, projectName) {
  const name = htmlEsc(projectName || root.split(/[/\\]/).filter(Boolean).pop() || '')
  const list = records.slice().reverse()

  const counts = { total: list.length, ok: 0, partial: 0, todo: 0, other: 0 }
  for (const r of list) counts[statusLevel(r.status)] += 1

  const stats = [
    { k: 'TOTAL / 记录', v: `${counts.total}<small>条</small>`, cls: 'total' },
    { k: 'OK / 通过', v: String(counts.ok), cls: 'okc' },
    { k: 'PARTIAL / 部分', v: String(counts.partial), cls: 'partc' },
    { k: 'TODO / 待办', v: String(counts.todo + counts.other), cls: 'todoc' },
  ]
  const statsHtml = stats.map((s) => `<div class="stat ${s.cls}"><span class="k">${s.k}</span><span class="v">${s.v}</span></div>`).join('\n')
  const meterTotal = Math.max(1, counts.ok + counts.partial + counts.todo + counts.other)
  const meterHtml = `<i class="m-ok" style="flex:${counts.ok}"></i><i class="m-part" style="flex:${counts.partial}"></i><i class="m-todo" style="flex:${counts.todo + counts.other}"></i>`

  // ---- plan / checklist / risks ----
  let planHtml = ''
  if (plan && (plan.plan || []).length > 0) {
    const rows = plan.plan.map((p) => [
      htmlEsc(p.id), htmlEsc(p.step), htmlEsc(p.acceptance),
      `<span class="${stClass(p.status)}">${htmlEsc(statusLabel(p.status))}</span>`,
      htmlEsc(p.owner || '—'), htmlEsc(p.due || '—'),
    ])
    planHtml += `<section class="logsec" aria-labelledby="plan-title">
      <div class="sec-head"><h2 id="plan-title">📋 执行计划</h2><div class="shown">${rows.length} 项</div></div>
      ${cardTable([
        { label: '#', width: '56px' }, { label: '步骤' }, { label: '验收标准' },
        { label: '状态', width: '110px' }, { label: '负责人', width: '96px' }, { label: '截止', width: '110px' },
      ], rows)}
    </section>`
  }

  if (plan && (plan.checklist || []).length > 0) {
    const rows = plan.checklist.map((c) => [
      htmlEsc(c.id), htmlEsc(c.item),
      `<span class="${stClass(c.status)}">${htmlEsc(statusLabel(c.status))}</span>`,
      htmlEsc(c.link || '—'),
    ])
    planHtml += `<section class="logsec" aria-labelledby="check-title">
      <div class="sec-head"><h2 id="check-title">✅ 检查清单</h2><div class="shown">${rows.length} 项</div></div>
      ${cardTable([
        { label: '#', width: '64px' }, { label: '项' }, { label: '状态', width: '120px' }, { label: '关联记录', width: '190px' },
      ], rows)}
    </section>`
  }

  if (plan && (plan.risks || []).length > 0) {
    const rows = plan.risks.map((r) => {
      const level = riskColor(r.probability, r.impact)
      return [
        `<span class="risk-dot" style="background:${level}"></span>${htmlEsc(r.risk)}`,
        htmlEsc(r.probability || '—'), htmlEsc(r.impact || '—'), htmlEsc(r.strategy || '—'),
        `<span class="${stClass(r.status)}">${htmlEsc(statusLabel(r.status))}</span>`,
      ]
    })
    planHtml += `<section class="logsec" aria-labelledby="risk-title">
      <div class="sec-head"><h2 id="risk-title">⚠️ 风险与应对</h2><div class="shown">${rows.length} 项</div></div>
      ${cardTable([
        { label: '风险' }, { label: '概率', width: '72px' }, { label: '影响', width: '72px' },
        { label: '策略', width: '96px' }, { label: '状态', width: '110px' },
      ], rows)}
    </section>`
  }

  // ---- log table ----
  const logRows = list.map((r) => {
    const ts = String(r.ts ?? '')
    const action = String(r.action ?? '')
    const status = String(r.status ?? '')
    const id = String(r.id ?? '')
    const search = `${action} ${status} ${String(r.summary ?? '')} ${id}`.toLowerCase()
    return `<tr class="entry" data-status="${htmlEsc(statusLevel(status))}" data-type="${htmlEsc(action)}" data-search="${htmlEsc(search)}">`
      + `<td class="c-time" data-label="时间"><time datetime="${htmlEsc(ts)}">${htmlEsc(ts)}</time></td>`
      + `<td class="c-type" data-label="类型"><span class="${typeClass(action)}">${htmlEsc(action || '—')}</span></td>`
      + `<td class="c-status" data-label="状态"><span class="${stClass(status)}">${htmlEsc(status || '—')}</span></td>`
      + `<td class="c-summary" data-label="摘要">${htmlEsc(r.summary)}</td>`
      + `<td class="c-id" data-label="记录 id"><button type="button" class="rid" data-copy="${htmlEsc(id)}" title="点击复制记录 id" aria-label="复制记录 id：${htmlEsc(id)}">${htmlEsc(id || '—')}</button></td>`
      + '</tr>'
  }).join('\n')

  const logSection = `<section class="logsec" id="log" aria-labelledby="log-title">
    <div class="sec-head">
      <h2 id="log-title">📜 工作日志</h2>
      <div class="shown"><span id="shown"><b>${counts.total}</b> / ${counts.total} 条</span></div>
    </div>
    <div class="toolbar" role="group" aria-label="日志筛选">
      <div class="chips">
        <button class="chip" type="button" data-filter="all" aria-pressed="true">全部 <span class="n">${counts.total}</span></button>
        <button class="chip" type="button" data-filter="ok" aria-pressed="false">ok <span class="n">${counts.ok}</span></button>
        <button class="chip" type="button" data-filter="partial" aria-pressed="false">partial <span class="n">${counts.partial}</span></button>
        <button class="chip" type="button" data-filter="todo" aria-pressed="false">待办 <span class="n">${counts.todo + counts.other}</span></button>
      </div>
      <div class="searchwrap">
        <svg class="ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="搜索摘要 / 类型 / id" autocomplete="off" spellcheck="false" aria-label="搜索工作日志">
        <kbd class="kbd" aria-hidden="true">/</kbd>
      </div>
    </div>
    <noscript><p class="noscript">当前浏览器禁用了脚本：状态筛选与搜索暂不可用，下方仍列出全部 ${counts.total} 条记录。</p></noscript>
    <div class="table-wrap">
      <table id="logtable">
        <caption class="sr-only">工作日志：时间、类型、状态、摘要与记录 id，共 ${counts.total} 条</caption>
        <colgroup><col class="w-time"><col class="w-type"><col class="w-status"><col><col class="w-id"></colgroup>
        <thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">摘要</th><th scope="col">记录 id</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>
    <div class="empty" id="empty" hidden>
      <span class="mono">NO MATCH</span>
      <p>没有匹配的记录，试试换个关键词。</p>
      <button class="chip" type="button" id="reset">重置筛选</button>
    </div>
  </section>`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${name} · 任务清单</title>
<style>
  :root{
    --bg:#03080b;--text:#d9e9e5;--muted:#6e8884;
    --line:rgba(126,222,199,.16);--line-soft:rgba(126,222,199,.075);
    --emerald:#2ee6a8;--cyan:#4fc3f7;--amber:#ffc266;--blue:#8ab4ff;
    --mono:"SF Mono",ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,"Liberation Mono",monospace;
    --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;color:var(--text);font-family:var(--sans);font-size:15px;line-height:1.6;
    background:#03080b;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .glow{position:fixed;inset:0;z-index:0;pointer-events:none;
    background:
      radial-gradient(1100px 680px at 8% -12%,rgba(24,128,98,.30),transparent 62%),
      radial-gradient(900px 620px at 102% 2%,rgba(20,86,138,.32),transparent 64%),
      radial-gradient(820px 520px at 50% 112%,rgba(14,72,64,.20),transparent 70%)}
  body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:linear-gradient(rgba(96,200,180,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(96,200,180,.055) 1px,transparent 1px);
    background-size:72px 72px;
    -webkit-mask-image:radial-gradient(ellipse 92% 62% at 50% 0%,#000 0%,rgba(0,0,0,.55) 42%,transparent 78%);
    mask-image:radial-gradient(ellipse 92% 62% at 50% 0%,#000 0%,rgba(0,0,0,.55) 42%,transparent 78%)}
  ::selection{background:rgba(46,230,168,.28);color:#f2fffb}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:#040a0d}
  ::-webkit-scrollbar-thumb{background:#12332e;border-radius:99px;border:2px solid #040a0d}
  ::-webkit-scrollbar-thumb:hover{background:#1b4b43}
  :focus-visible{outline:2px solid rgba(46,230,168,.7);outline-offset:2px}
  [hidden]{display:none!important}
  .progress{position:fixed;top:0;left:0;height:2px;width:0;z-index:60;
    background:linear-gradient(90deg,var(--emerald),var(--cyan));box-shadow:0 0 12px rgba(46,230,168,.7)}
  .wrap{position:relative;z-index:1;max-width:1060px;margin:0 auto;padding:40px 26px 48px}
  .hero{position:relative;overflow:hidden;border:1px solid rgba(126,222,199,.18);border-radius:18px;
    background:linear-gradient(145deg,rgba(8,20,24,.92),rgba(4,12,16,.86));
    box-shadow:0 30px 70px -40px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.04);padding:30px 26px 26px}
  .hero::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;
    background:radial-gradient(560px 200px at 12% -20%,rgba(46,230,168,.14),transparent 70%)}
  .corner{position:absolute;width:16px;height:16px;border:1px solid rgba(46,230,168,.5);opacity:.6}
  .corner.tl{top:12px;left:12px;border-right:0;border-bottom:0}
  .corner.tr{top:12px;right:12px;border-left:0;border-bottom:0}
  .corner.bl{bottom:12px;left:12px;border-right:0;border-top:0}
  .corner.br{bottom:12px;right:12px;border-left:0;border-top:0}
  .orbit{position:absolute;top:-70px;right:-72px;width:250px;height:250px;opacity:.5;pointer-events:none;
    animation:spin 90s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .hero-inner{position:relative;z-index:1}
  .kicker{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:10px;letter-spacing:.24em;
    text-transform:uppercase;color:#7ea79d}
  .kicker .sep{color:#3c5f59}
  .pulse{width:6px;height:6px;border-radius:50%;background:var(--emerald);box-shadow:0 0 0 0 rgba(46,230,168,.6);
    animation:pulse 2.6s infinite}
  @keyframes pulse{70%{box-shadow:0 0 0 9px rgba(46,230,168,0)}100%{box-shadow:0 0 0 0 rgba(46,230,168,0)}}
  h1{margin:14px 0 0;font-size:clamp(21px,3.1vw,29px);font-weight:650;letter-spacing:-.01em;line-height:1.25}
  h1 .hsep{color:#3f6159;margin:0 2px}
  h1 .accent{background:linear-gradient(100deg,var(--emerald),var(--cyan));-webkit-background-clip:text;
    background-clip:text;color:transparent}
  .meta{margin-top:8px;font-family:var(--mono);font-size:12px;color:#8aa5a1;letter-spacing:.02em}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:20px;
    background:var(--line-soft);border:1px solid var(--line-soft);border-radius:11px;overflow:hidden}
  .stat{background:rgba(6,15,18,.74);padding:13px 18px;display:flex;flex-direction:column;gap:1px}
  .stat .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#6f8b86}
  .stat .v{font-family:var(--mono);font-size:27px;line-height:1.2;font-weight:600;color:#eafff8}
  .stat .v small{font-size:10.5px;color:#6f8b86;margin-left:4px;letter-spacing:.08em;font-weight:400}
  .stat.okc .v{color:var(--emerald);text-shadow:0 0 26px rgba(46,230,168,.35)}
  .stat.partc .v{color:var(--amber);text-shadow:0 0 26px rgba(255,194,102,.28)}
  .stat.todoc .v{color:var(--blue);text-shadow:0 0 26px rgba(138,180,255,.28)}
  .meter{display:flex;height:4px;margin-top:14px;border-radius:99px;overflow:hidden;background:rgba(126,222,199,.08)}
  .meter i{display:block;height:100%}
  .meter .m-ok{background:linear-gradient(90deg,#2ee6a8,#4ff0bb)}
  .meter .m-part{background:linear-gradient(90deg,#ffc266,#ffd79a)}
  .meter .m-todo{background:linear-gradient(90deg,#8ab4ff,#b9d2ff)}
  .logsec{position:relative;margin-top:26px;border:1px solid var(--line-soft);border-radius:14px;overflow:hidden;
    background:linear-gradient(180deg,rgba(6,14,18,.7),rgba(4,10,13,.55))}
  .sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:14px 18px;border-bottom:1px solid var(--line-soft)}
  .sec-head h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em;color:#dff3ec}
  .shown{font-family:var(--mono);font-size:11px;color:#7d9894;letter-spacing:.06em;white-space:nowrap}
  .shown b{color:var(--emerald);font-weight:500}
  .toolbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding:12px 16px;border-bottom:1px solid var(--line-soft);background:rgba(4,10,13,.92);
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{appearance:none;border:1px solid rgba(126,222,199,.16);background:rgba(10,22,25,.5);color:#93b6ad;
    font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;padding:6px 11px;border-radius:7px;cursor:pointer;
    display:inline-flex;align-items:center;gap:6px;transition:color .2s,border-color .2s,background .2s}
  .chip .n{color:#6f8b86;font-size:10px}
  .chip:hover{color:#dffaf2;border-color:rgba(46,230,168,.45);background:rgba(46,230,168,.07)}
  .chip[aria-pressed="true"]{color:#04211a;background:linear-gradient(100deg,#4ff0bb,#2ee6a8);
    border-color:transparent;font-weight:600;box-shadow:0 0 18px -4px rgba(46,230,168,.55)}
  .chip[aria-pressed="true"] .n{color:rgba(4,33,26,.66)}
  .searchwrap{position:relative;margin-left:auto;min-width:230px}
  .searchwrap .ico{position:absolute;left:11px;top:50%;transform:translateY(-50%);opacity:.55;pointer-events:none;color:#8fd8c4}
  #q{width:100%;font-family:var(--mono);font-size:12px;color:#d7efe8;background:rgba(3,9,12,.75);
    border:1px solid rgba(126,222,199,.16);border-radius:8px;padding:8px 30px 8px 32px;outline:none;
    transition:border-color .2s,box-shadow .2s}
  #q::placeholder{color:#647f7a}
  #q:focus{border-color:rgba(46,230,168,.6);box-shadow:0 0 0 3px rgba(46,230,168,.12)}
  .kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:9.5px;
    color:#6a8580;border:1px solid rgba(126,222,199,.2);border-radius:4px;padding:1px 5px;
    background:rgba(255,255,255,.03);pointer-events:none}
  .noscript{margin:0;padding:9px 18px;border-bottom:1px solid var(--line-soft);
    background:rgba(251,191,36,.06);color:#f6cf7d;font-size:12px;line-height:1.6}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .table-wrap{overflow-x:auto}
  .table-wrap table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:900px}
  .table-wrap.ptable table{min-width:640px}
  col.w-time{width:206px}col.w-type{width:128px}col.w-status{width:110px}col.w-id{width:200px}
  thead th{position:sticky;top:0;z-index:2;text-align:left;padding:11px 16px;white-space:nowrap;
    font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.16em;color:var(--muted);
    background:rgba(4,11,14,.95);border-bottom:1px solid var(--line);
    -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
  tbody tr{transition:background .25s ease}
  tbody td{padding:15px 16px;border-bottom:1px solid var(--line-soft);vertical-align:top;font-size:13.5px}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:nth-child(even){background:rgba(126,222,199,.016)}
  tbody tr:hover,tbody tr:nth-child(even):hover{
    background:linear-gradient(90deg,rgba(46,230,168,.06),rgba(79,195,247,.022) 46%,transparent 80%)}
  tbody tr:hover td:first-child{box-shadow:inset 2px 0 0 rgba(46,230,168,.8)}
  .c-time time{font-family:var(--mono);font-size:11px;line-height:1.75;color:#87a3a8;
    white-space:nowrap;font-variant-numeric:tabular-nums}
  .c-type{white-space:nowrap}
  .tag{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-family:var(--mono);
    font-size:10.5px;line-height:1;letter-spacing:.03em;padding:5px 7px;border-radius:5px;
    border:1px solid rgba(126,222,199,.16);background:rgba(126,222,199,.05);color:#a9d8cc}
  .tag::before{content:"";width:4px;height:4px;flex:none;background:currentColor;opacity:.8;box-shadow:0 0 6px currentColor}
  .tag-task_done{color:#86efac;border-color:rgba(74,222,128,.24);background:rgba(74,222,128,.07)}
  .tag-fix{color:#fcd34d;border-color:rgba(251,191,36,.24);background:rgba(251,191,36,.07)}
  .tag-doc{color:#7dd3fc;border-color:rgba(56,189,248,.24);background:rgba(56,189,248,.07)}
  .tag-build{color:#c4b5fd;border-color:rgba(167,139,250,.26);background:rgba(167,139,250,.08)}
  .tag-maintenance{color:#b6c6c9;border-color:rgba(182,198,201,.20);background:rgba(182,198,201,.06)}
  .tag-diagnosis{color:#fda4af;border-color:rgba(251,113,133,.24);background:rgba(251,113,133,.07)}
  .tag-review{color:#67e8f9;border-color:rgba(103,232,249,.24);background:rgba(103,232,249,.07)}
  .tag-task_start{color:#93c5fd;border-color:rgba(147,197,253,.24);background:rgba(147,197,253,.07)}
  .tag-commit{color:#a7f3d0;border-color:rgba(167,243,208,.24);background:rgba(167,243,208,.07)}
  .tag-rollback,.tag-correction{color:#fca5a5;border-color:rgba(252,165,165,.24);background:rgba(252,165,165,.07)}
  .tag-handoff{color:#f0abfc;border-color:rgba(240,171,252,.24);background:rgba(240,171,252,.07)}
  .c-status{white-space:nowrap}
  .st{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;
    font-weight:600;line-height:1;letter-spacing:.03em;padding:5px 10px;border-radius:999px;border:1px solid transparent}
  .st::before{content:"";width:5px;height:5px;flex:none;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
  .st-ok{color:#2ee6a8;background:rgba(46,230,168,.09);border-color:rgba(46,230,168,.30)}
  .st-partial{color:#ffc266;background:rgba(255,194,102,.08);border-color:rgba(255,194,102,.26)}
  .st-todo{color:#8ab4ff;background:rgba(138,180,255,.08);border-color:rgba(138,180,255,.26)}
  .st-other{color:#cbd5e1;background:rgba(203,213,225,.08);border-color:rgba(203,213,225,.22)}
  .c-summary{color:#c9dcd7;line-height:1.78;overflow-wrap:break-word}
  .risk-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:1px;
    box-shadow:0 0 8px currentColor}
  .rid{display:inline-block;margin:0;font-family:var(--mono);font-size:10px;line-height:1.55;letter-spacing:.01em;
    text-align:left;color:#6f8a90;background:rgba(126,222,199,.04);border:1px solid rgba(126,222,199,.09);
    border-radius:4px;padding:2px 6px;cursor:pointer;transition:color .2s,border-color .2s,background .2s;
    font-variant-numeric:tabular-nums;white-space:nowrap}
  .rid:hover{color:#a9f5e3;border-color:rgba(46,230,168,.42)}
  .rid:active,.rid.done{color:#04211a;background:#2ee6a8;border-color:transparent}
  tbody tr:hover .rid{color:#a9cfc9;border-color:rgba(46,230,168,.26)}
  .empty{display:none;flex-direction:column;align-items:center;gap:8px;padding:58px 20px;color:#7e9a96;text-align:center}
  .empty:not([hidden]){display:flex}
  .empty .mono{font-family:var(--mono);font-size:10px;letter-spacing:.26em;color:var(--amber)}
  .empty p{margin:0;font-size:13px}
  .toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,12px);z-index:80;opacity:0;
    pointer-events:none;font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:#c9fff0;
    background:rgba(6,20,18,.96);border:1px solid rgba(46,230,168,.42);border-radius:9px;padding:8px 14px;
    box-shadow:0 16px 40px -14px rgba(0,0,0,.9);transition:opacity .25s ease,transform .25s ease;
    max-width:88vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .toast.show{opacity:1;transform:translate(-50%,0)}
  footer{margin-top:26px;padding-top:18px;border-top:1px solid rgba(126,222,199,.08);
    text-align:center;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.03em}
  @media (max-width:1040px){
    .wrap{padding:30px 18px 36px}
    .hero{padding:24px 20px 22px}
    .orbit{opacity:.3;width:190px;height:190px;top:-60px;right:-64px}
    .logsec{border-radius:12px}
    .table-wrap{overflow:visible}
    .table-wrap table{min-width:0;table-layout:auto;display:block}
    .table-wrap colgroup,.table-wrap thead{display:none}
    .table-wrap tbody{display:block}
    tbody tr{display:flex;flex-wrap:wrap;align-items:center;gap:7px 10px;padding:15px 16px;
      border-bottom:1px solid var(--line-soft)}
    tbody tr:last-child{border-bottom:0}
    tbody td{display:block;width:auto;padding:0;border:0;box-shadow:none!important;background:none!important}
    tbody tr:hover td:first-child{box-shadow:none}
    .c-time{flex:1 0 100%}
    .c-type{order:1}
    .c-status{order:2}
    .c-summary{order:3;flex:1 0 100%;margin-top:1px;font-size:13px;line-height:1.72}
    .c-id{order:4;flex:1 0 100%;margin-top:1px}
    .c-summary::before,.c-id::before{display:inline-block;margin-right:6px;color:var(--muted);
      font-family:var(--mono);font-size:9.5px;letter-spacing:.16em}
    .c-summary::before{content:attr(data-label);display:block;margin:0 0 3px}
    .c-id::before{content:attr(data-label)}
    .c-time time{font-size:11.5px;color:#8fa9ae}
    .table-wrap.ptable tbody tr{display:flex}
    .ptable tbody td{flex:1 0 100%;margin-top:2px}
    .ptable tbody td::before{content:attr(data-label);display:block;color:var(--muted);
      font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;margin-bottom:3px}
  }
  @media (max-width:760px){
    .searchwrap{width:100%;margin-left:0;min-width:0}
    .kbd{display:none}
  }
  @media (max-width:560px){
    .hero h1{font-size:21px}
    .stats{grid-template-columns:1fr 1fr}
    .stat{padding:10px 13px}
    .stat .v{font-size:22px}
    .toolbar{padding:10px 12px}
    .chip{font-size:10px;padding:5px 9px}
  }
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation:none!important;transition:none!important}
  }
</style>
</head>
<body>
<div class="progress" id="progress"></div>
<div class="glow" aria-hidden="true"></div>
<main class="wrap">
  <header class="hero">
    <span class="corner tl" aria-hidden="true"></span>
    <span class="corner tr" aria-hidden="true"></span>
    <span class="corner bl" aria-hidden="true"></span>
    <span class="corner br" aria-hidden="true"></span>
    <div class="orbit" aria-hidden="true">
      <svg viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="88" stroke="rgba(79,195,247,.16)" stroke-width="1"/>
        <circle cx="100" cy="100" r="66" stroke="rgba(46,230,168,.26)" stroke-width="1" stroke-dasharray="2 7"/>
        <circle cx="100" cy="100" r="38" stroke="rgba(46,230,168,.14)" stroke-width="1"/>
        <path d="M100 3v20M100 177v20M3 100h20M177 100h20" stroke="rgba(126,222,199,.45)" stroke-width="1"/>
        <circle cx="100" cy="100" r="2.6" fill="#2ee6a8"/>
      </svg>
    </div>
    <div class="hero-inner">
      <div class="kicker"><span class="pulse" aria-hidden="true"></span><span>WORKSPACE LOG</span><span class="sep">/</span><span>DSH</span></div>
      <h1>${name} <span class="hsep">·</span> <span class="accent">任务清单</span></h1>
      <div class="meta">日志共 ${counts.total} 条${plan && plan.updated_at ? ` &#183; 计划更新 ${htmlEsc(plan.updated_at)}` : ''} &#183; 生成: ${htmlEsc(now)}</div>
      <div class="stats">${statsHtml}</div>
      <div class="meter" role="img" aria-label="状态分布">${meterHtml}</div>
    </div>
  </header>
  ${planHtml}
  ${logSection}
  <footer>自动生成 &#183; 来源 .ai/log.jsonl + .ai/plan.json &#183; 勿手动编辑</footer>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('#logtable tbody tr'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-filter]'));
  var input = document.getElementById('q');
  var shown = document.getElementById('shown');
  var empty = document.getElementById('empty');
  var filter = 'all';

  function apply(){
    var q = (input.value || '').trim().toLowerCase();
    var n = 0;
    rows.forEach(function(el){
      var okStatus = filter === 'all' || el.getAttribute('data-status') === filter;
      var okQuery = !q || (el.getAttribute('data-search') || '').indexOf(q) !== -1;
      var ok = okStatus && okQuery;
      el.hidden = !ok;
      if (ok) n++;
    });
    shown.innerHTML = '<b>' + n + '</b> / ' + rows.length + ' 条';
    empty.hidden = n !== 0;
  }

  chips.forEach(function(c){
    c.addEventListener('click', function(){
      chips.forEach(function(x){ x.setAttribute('aria-pressed','false'); });
      c.setAttribute('aria-pressed','true');
      filter = c.getAttribute('data-filter');
      apply();
    });
  });

  if (input) {
    input.addEventListener('input', apply);
    document.addEventListener('keydown', function(e){
      if (e.key === '/' && document.activeElement !== input){ e.preventDefault(); input.focus(); }
      if (e.key === 'Escape' && document.activeElement === input){ input.value = ''; apply(); input.blur(); }
    });
  }

  var reset = document.getElementById('reset');
  if (reset) reset.addEventListener('click', function(){
    filter = 'all';
    chips.forEach(function(x){ x.setAttribute('aria-pressed', x.getAttribute('data-filter') === 'all' ? 'true' : 'false'); });
    if (input) input.value = '';
    apply();
    if (input) input.focus();
  });

  var toast = document.getElementById('toast');
  var toastTimer = null;
  function showToast(msg){
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.classList.remove('show'); }, 1600);
  }

  function copyText(text, btn){
    var done = function(){
      btn.classList.add('done');
      showToast('已复制 ' + text);
      setTimeout(function(){ btn.classList.remove('done'); }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ fallback(text, done); });
    } else {
      fallback(text, done);
    }
  }

  function fallback(text, done){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly','');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch(err) { showToast('复制失败，请手动选择 id'); }
    document.body.removeChild(ta);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.rid'), function(btn){
    btn.addEventListener('click', function(){ copyText(btn.getAttribute('data-copy'), btn); });
  });

  var bar = document.getElementById('progress');
  var ticking = false;
  function onScroll(){
    if (ticking || !bar) return;
    ticking = true;
    requestAnimationFrame(function(){
      var doc = document.documentElement;
      var max = doc.scrollHeight - doc.clientHeight;
      bar.style.width = (max > 0 ? (doc.scrollTop || document.body.scrollTop) / max * 100 : 0) + '%';
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>
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