/**
 * 跨项目仪表盘渲染：读取父目录下各项目 status.json + log.jsonl 行数，
 * 生成 `board.md` 同级目录的 `dashboard.html`（自包含单文件，同 TASKS.html 风格）。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readText, writeFileAtomic } from './atomic.js'

// ---------------------------------------------------------------- helpers

export function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function htmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function readJsonFile(path) {
  try { return JSON.parse(readText(path)) } catch { return null }
}

/** 读 `<root>/.ai/log.jsonl` 非空行数。 */
function logLineCount(root) {
  try {
    const raw = readText(join(root, '.ai', 'log.jsonl'))
    return raw.split('\n').filter((l) => l.trim().length > 0).length
  } catch { return 0 }
}

function phaseLabel(phase) {
  const map = { init: '初始化', build: '构建', feature: '特性开发', 'attitude-validation': '姿态验证',
    diagnosis: '诊断', maintain: '维护', deliver: '交付' }
  return map[phase] || phase || '—'
}

// ---------------------------------------------------------------- scan

export function scanProjects(parent) {
  const rows = []
  for (const entry of readdirSafe(parent)) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    const st = readJsonFile(join(parent, entry, '.ai', 'status.json'))
    if (!st) continue
    rows.push({
      project: st.project || entry,
      dir: entry,
      phase: st.phase || '',
      focus: st.focus || '',
      blockers: st.blockers || [],
      next: st.next || [],
      updated_at: st.updated_at || '',
      logCount: logLineCount(join(parent, entry)),
    })
  }
  return rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

// ---------------------------------------------------------------- render: dashboard.html

export function renderDashboard(rows, parent, now) {
  const dir = htmlEsc(parent)
  const totalProjects = rows.length
  const totalRecords = rows.reduce((s, r) => s + r.logCount, 0)
  const blocking = rows.filter((r) => r.blockers.length > 0)
  const maxLog = Math.max(1, ...rows.map((r) => r.logCount))

  let tableHtml = ''
  for (const r of rows) {
    const hasBlock = r.blockers.length > 0
    const blockText = hasBlock ? r.blockers.map((b) => htmlEsc(b)).join('; ') : '—'
    const trClass = hasBlock ? ' style="background:#fff5f5"' : ''
    tableHtml += `<tr${trClass}>
      <td>${hasBlock ? '<span class="badge blocked">阻塞</span>' : ''}</td>
      <td><strong>${htmlEsc(r.project)}</strong></td>
      <td>${phaseLabel(r.phase)}</td>
      <td>${htmlEsc(r.focus)}</td>
      <td>${blockText}</td>
      <td><a href="${htmlEsc(r.dir)}/TASKS.html" title="任务清单">${r.logCount} 条</a></td>
      <td class="muted">${htmlEsc(r.updated_at)}</td>
    </tr>`
  }

  let barHtml = ''
  for (const r of rows) {
    const pct = Math.round((r.logCount / maxLog) * 100)
    const color = r.logCount >= 40 ? '#198754' : r.logCount >= 20 ? '#0d6efd' : '#6c757d'
    barHtml += `<div class="bar-row">
      <span class="bar-label">${htmlEsc(r.project)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="bar-count">${r.logCount}</span>
    </div>`
  }

  let blockHtml = ''
  if (blocking.length > 0) {
    blockHtml = '<section class="blocking"><h2>🚨 当前阻塞</h2><ul>'
    for (const r of blocking) {
      for (const b of r.blockers) {
        blockHtml += `<li><strong>${htmlEsc(r.project)}</strong>：${htmlEsc(b)}</li>`
      }
    }
    blockHtml += '</ul></section>'
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>跨项目仪表盘</title>
<style>
:root { --bg:#f8f9fa; --card:#fff; --text:#212529; --muted:#6c757d; --border:#dee2e6; font-family:system-ui,-apple-system,sans-serif; }
body { background:var(--bg); color:var(--text); margin:0; padding:16px; }
.container { max-width:1100px; margin:0 auto; }
header { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px 24px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
header h1 { margin:0; font-size:20px; }
header .stats { display:flex; gap:16px; }
header .stat { text-align:center; }
header .stat .num { font-size:22px; font-weight:700; }
header .stat .label { font-size:11px; color:var(--muted); }
section { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px 24px; margin-bottom:16px; }
section h2 { margin:0 0 12px; font-size:16px; }
section.blocking { border-color:#dc3545; }
section.blocking ul { margin:0; padding-left:20px; color:#dc3545; }
section.blocking li { margin-bottom:4px; }
section.blocking strong { color:var(--text); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
th { background:#f1f3f5; font-weight:600; white-space:nowrap; }
tr:hover { background:#f8f9fa; }
.muted { color:var(--muted); font-size:12px; }
.badge { display:inline-block; padding:2px 6px; border-radius:3px; font-size:11px; font-weight:600; }
.badge.blocked { background:#dc3545; color:#fff; }
a { color:#0d6efd; text-decoration:none; }
a:hover { text-decoration:underline; }
.bar-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px; }
.bar-label { min-width:80px; text-align:right; font-weight:500; }
.bar-track { flex:1; height:18px; background:#e9ecef; border-radius:4px; overflow:hidden; }
.bar-fill { height:100%; border-radius:4px; transition:width .3s; }
.bar-count { min-width:30px; font-variant-numeric:tabular-nums; color:var(--muted); }
footer { text-align:center; color:var(--muted); font-size:12px; padding:12px; }
</style>
</head>
<body>
<div class="container">
<header>
  <div><h1>📊 跨项目仪表盘</h1><div class="muted">扫描：${dir} · 共 ${totalProjects} 个项目 · ${now}</div></div>
  <div class="stats">
    <div class="stat"><div class="num">${totalProjects}</div><div class="label">项目</div></div>
    <div class="stat"><div class="num">${totalRecords}</div><div class="label">记录</div></div>
    <div class="stat"><div class="num" style="color:#dc3545">${blocking.length}</div><div class="label">阻塞</div></div>
  </div>
</header>
${blockHtml}
<section><h2>记录趋势</h2>${barHtml}</section>
<section><h2>项目总览</h2>
<table>
<tr><th></th><th>项目</th><th>阶段</th><th>焦点</th><th>阻塞</th><th>记录</th><th class="muted">最后更新</th></tr>
${tableHtml}
</table>
</section>
<footer>自动生成 · 来源各项目 .ai/status.json + .ai/log.jsonl · 勿手动编辑</footer>
</div>
</body>
</html>
`
}

// ---------------------------------------------------------------- write

/**
 * 读父目录 `board.md` 的位置来确定仪表盘输出路径。
 * 目标：`<board.md 所在目录>\dashboard.html`。
 * 当父目录没有 board.md 时返回 null。
 */
export function writeDashboard(root) {
  const parent = dirname(root)
  const boardPath = join(parent, '.ai', 'board.md')
  if (!existsSync(boardPath)) return null
  const rows = scanProjects(parent)
  const now = new Date().toISOString()
  const outPath = join(parent, '.ai', 'dashboard.html')
  mkdirSync(join(parent, '.ai'), { recursive: true })
  writeFileAtomic(outPath, renderDashboard(rows, parent, now))
  return { path: outPath, rows: rows.length, written: true }
}