/**
 * 跨项目仪表盘渲染：读取父目录下各项目 status.json + log.jsonl 行数，
 * 生成 `board.md` 同级目录的 `dashboard.html`（自包含单文件，与 TASKS.html 同一视觉体系：
 * 深色 + 自适应表格，窗口变窄时表格降级为卡片）。
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

/** 占位式“阻塞”——不是真阻塞（“无”“—”等），统计与展示都要跳过。 */
const PLACEHOLDER_BLOCKER = /^(无|暂无|none|n\/a|-|—|--)?$/i

function realBlockers(status) {
  const list = Array.isArray(status?.blockers) ? status.blockers : []
  return list.map((b) => String(b ?? '').trim()).filter((b) => !PLACEHOLDER_BLOCKER.test(b))
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
      blockers: realBlockers(st),
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

  const statsHtml = [
    { k: 'PROJECTS / 项目', v: String(totalProjects), cls: '' },
    { k: 'RECORDS / 记录', v: String(totalRecords), cls: 'okc' },
    { k: 'BLOCKING / 阻塞', v: String(blocking.length), cls: blocking.length > 0 ? 'partc' : 'okc' },
    { k: 'MAX / 单项目记录', v: String(maxLog), cls: 'todoc' },
  ].map((s) => `<div class="stat ${s.cls}"><span class="k">${s.k}</span><span class="v">${s.v}</span></div>`).join('\n')

  // ---- 项目总览（表格 → 窄窗卡片）
  const projectRows = rows.map((r) => {
    const hasBlock = r.blockers.length > 0
    const blockText = hasBlock ? r.blockers.map((b) => htmlEsc(b)).join('；') : '—'
    const badge = hasBlock ? '<span class="st st-blocked">阻塞</span>' : '<span class="st st-ok">正常</span>'
    return `<tr class="row"${hasBlock ? ' data-blocked="1"' : ''}>`
      + `<td class="c-state" data-label="状态">${badge}</td>`
      + `<td class="c-name" data-label="项目"><a class="plink" href="../${encodeURIComponent(r.dir)}/TASKS.html" title="打开任务清单">${htmlEsc(r.project)}</a></td>`
      + `<td class="c-phase" data-label="阶段">${htmlEsc(phaseLabel(r.phase))}</td>`
      + `<td class="c-focus" data-label="焦点">${htmlEsc(r.focus || '—')}</td>`
      + `<td class="c-block" data-label="阻塞">${blockText}</td>`
      + `<td class="c-count" data-label="记录"><a class="plink" href="../${encodeURIComponent(r.dir)}/TASKS.html" title="打开任务清单">${r.logCount} 条</a></td>`
      + `<td class="c-time" data-label="最后更新"><time datetime="${htmlEsc(r.updated_at)}">${htmlEsc(r.updated_at || '—')}</time></td>`
      + '</tr>'
  }).join('\n')

  // ---- 记录趋势条
  const barHtml = rows.map((r) => {
    const pct = Math.round((r.logCount / maxLog) * 100)
    const color = r.logCount >= 40 ? 'linear-gradient(90deg,#2ee6a8,#4ff0bb)'
      : r.logCount >= 20 ? 'linear-gradient(90deg,#4fc3f7,#93c5fd)'
        : 'linear-gradient(90deg,#55707a,#7d9894)'
    return `<div class="bar-row">
      <span class="bar-label">${htmlEsc(r.project)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="bar-count">${r.logCount}</span>
    </div>`
  }).join('\n')

  // ---- 阻塞清单
  let blockHtml = ''
  if (blocking.length > 0) {
    const items = []
    for (const r of blocking) {
      for (const b of r.blockers) {
        items.push(`<li><a class="bl-proj" href="../${encodeURIComponent(r.dir)}/TASKS.html">${htmlEsc(r.project)}</a><span class="bl-text">${htmlEsc(b)}</span></li>`)
      }
    }
    blockHtml = `<section class="logsec" aria-labelledby="block-title">
      <div class="sec-head"><h2 id="block-title">🚨 当前阻塞</h2><div class="shown">${items.length} 项</div></div>
      <ul class="blocklist">${items.join('\n')}</ul>
    </section>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>跨项目仪表盘</title>
<style>
  :root{
    --bg:#03080b;--text:#d9e9e5;--muted:#6e8884;
    --line:rgba(126,222,199,.16);--line-soft:rgba(126,222,199,.075);
    --emerald:#2ee6a8;--cyan:#4fc3f7;--amber:#ffc266;--blue:#8ab4ff;--red:#f87171;
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
  :focus-visible{outline:2px solid rgba(46,230,168,.7);outline-offset:2px}
  .wrap{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:40px 26px 48px}
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
  .kicker{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:10px;letter-spacing:.24em;
    text-transform:uppercase;color:#7ea79d}
  .kicker .sep{color:#3c5f59}
  .pulse{width:6px;height:6px;border-radius:50%;background:var(--emerald);box-shadow:0 0 0 0 rgba(46,230,168,.6);
    animation:pulse 2.6s infinite}
  @keyframes pulse{70%{box-shadow:0 0 0 9px rgba(46,230,168,0)}100%{box-shadow:0 0 0 0 rgba(46,230,168,0)}}
  h1{margin:14px 0 0;font-size:clamp(21px,3.1vw,29px);font-weight:650;letter-spacing:-.01em;line-height:1.25}
  h1 .accent{background:linear-gradient(100deg,var(--emerald),var(--cyan));-webkit-background-clip:text;
    background-clip:text;color:transparent}
  .meta{margin-top:8px;font-family:var(--mono);font-size:12px;color:#8aa5a1;letter-spacing:.02em;
    overflow-wrap:anywhere}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:20px;
    background:var(--line-soft);border:1px solid var(--line-soft);border-radius:11px;overflow:hidden}
  .stat{background:rgba(6,15,18,.74);padding:13px 18px;display:flex;flex-direction:column;gap:1px}
  .stat .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#6f8b86}
  .stat .v{font-family:var(--mono);font-size:27px;line-height:1.2;font-weight:600;color:#eafff8}
  .stat.okc .v{color:var(--emerald);text-shadow:0 0 26px rgba(46,230,168,.35)}
  .stat.partc .v{color:var(--amber);text-shadow:0 0 26px rgba(255,194,102,.28)}
  .stat.todoc .v{color:var(--blue);text-shadow:0 0 26px rgba(138,180,255,.28)}
  .logsec{position:relative;margin-top:26px;border:1px solid var(--line-soft);border-radius:14px;overflow:hidden;
    background:linear-gradient(180deg,rgba(6,14,18,.7),rgba(4,10,13,.55))}
  .sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:14px 18px;border-bottom:1px solid var(--line-soft)}
  .sec-head h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em;color:#dff3ec}
  .shown{font-family:var(--mono);font-size:11px;color:#7d9894;letter-spacing:.06em;white-space:nowrap}
  .blocklist{list-style:none;margin:0;padding:6px 0}
  .blocklist li{display:flex;gap:10px;align-items:flex-start;padding:10px 18px;
    border-bottom:1px solid var(--line-soft);font-size:13.5px;color:#f5b8b8}
  .blocklist li:last-child{border-bottom:0}
  .bl-proj{flex:none;font-weight:600;color:#ffd7d7;text-decoration:none;
    border-bottom:1px dotted rgba(255,215,215,.38);white-space:nowrap}
  .bl-proj::after{content:"：";color:#b98f8f;font-weight:400}
  .bl-proj:hover{color:#fff;border-bottom-style:solid}
  .bl-text{flex:1;color:#e6cfcf;line-height:1.7;overflow-wrap:anywhere}
  .table-wrap{overflow-x:auto}
  .table-wrap table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:980px}
  col.w-state{width:92px}col.w-name{width:170px}col.w-phase{width:96px}col.w-count{width:92px}col.w-time{width:184px}
  thead th{position:sticky;top:0;z-index:2;text-align:left;padding:11px 16px;white-space:nowrap;
    font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.16em;color:var(--muted);
    background:rgba(4,11,14,.95);border-bottom:1px solid var(--line)}
  tbody tr{transition:background .25s ease}
  tbody td{padding:14px 16px;border-bottom:1px solid var(--line-soft);vertical-align:top;font-size:13.5px;color:#c9dcd7}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:nth-child(even){background:rgba(126,222,199,.016)}
  tbody tr:hover,tbody tr:nth-child(even):hover{
    background:linear-gradient(90deg,rgba(46,230,168,.06),rgba(79,195,247,.022) 46%,transparent 80%)}
  tbody tr:hover td:first-child{box-shadow:inset 2px 0 0 rgba(46,230,168,.8)}
  tbody tr[data-blocked] td:first-child{box-shadow:inset 2px 0 0 rgba(248,113,113,.8)}
  tbody tr[data-blocked]{background:rgba(248,113,113,.045)}
  .c-name{font-weight:600;color:#e8fbf4;overflow-wrap:anywhere}
  .c-block{color:#e6cfcf;line-height:1.72;overflow-wrap:anywhere}
  .c-count a{font-family:var(--mono);font-size:12px;color:#8fd8c4;text-decoration:none;
    border-bottom:1px dotted rgba(143,216,196,.4)}
  .c-count a:hover{color:#c9fff0;border-bottom-style:solid}
  .c-time time{font-family:var(--mono);font-size:10.5px;color:#87a3a8;line-height:1.7;
    white-space:nowrap;font-variant-numeric:tabular-nums}
  a.plink{color:#9fe8cf;text-decoration:none;border-bottom:1px dotted rgba(159,232,207,.4)}
  a.plink:hover{color:#d9fff4;border-bottom-style:solid}
  .st{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;
    font-weight:600;line-height:1;letter-spacing:.03em;padding:4px 9px;border-radius:999px;border:1px solid transparent}
  .st::before{content:"";width:5px;height:5px;flex:none;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
  .st-ok{color:#2ee6a8;background:rgba(46,230,168,.09);border-color:rgba(46,230,168,.30)}
  .st-blocked{color:#f87171;background:rgba(248,113,113,.10);border-color:rgba(248,113,113,.34)}
  .bar-row{display:flex;align-items:center;gap:12px;padding:7px 18px;font-size:12.5px}
  .bar-row:hover{background:rgba(46,230,168,.035)}
  .bar-label{flex:0 0 190px;text-align:right;font-family:var(--mono);font-size:11px;color:#a9c8c0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar-track{flex:1;height:8px;background:rgba(126,222,199,.08);border-radius:99px;overflow:hidden}
  .bar-fill{display:block;height:100%;border-radius:99px;box-shadow:0 0 14px -2px rgba(46,230,168,.5)}
  .bar-count{flex:0 0 44px;text-align:right;font-family:var(--mono);font-size:11px;color:#8aa5a1;
    font-variant-numeric:tabular-nums}
  footer{margin-top:26px;padding-top:18px;border-top:1px solid rgba(126,222,199,.08);
    text-align:center;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.03em}
  @media (max-width:1040px){
    .wrap{padding:30px 18px 36px}
    .hero{padding:24px 20px 22px}
    .logsec{border-radius:12px}
    .table-wrap{overflow:visible}
    .table-wrap table{min-width:0;table-layout:auto;display:block}
    .table-wrap colgroup,.table-wrap thead{display:none}
    .table-wrap tbody{display:block}
    tbody tr{display:flex;flex-wrap:wrap;align-items:center;gap:7px 10px;padding:14px 16px;
      border-bottom:1px solid var(--line-soft)}
    tbody tr:last-child{border-bottom:0}
    tbody tr:hover td:first-child{box-shadow:none}
    tbody td{display:block;width:auto;padding:0;border:0;background:none!important}
    .c-state{order:1}
    .c-phase{order:2}
    .c-name{order:3;flex:1 0 100%;margin-top:2px}
    .c-focus{order:4;flex:1 0 100%;font-size:12.5px;color:#9fb8b2}
    .c-block{order:5;flex:1 0 100%;margin-top:2px}
    .c-count{order:6}
    .c-time{order:7;flex:1 0 100%;margin-top:2px}
    .c-focus::before,.c-block::before,.c-time::before,.c-count::before,.c-phase::before{
      content:attr(data-label);display:inline-block;margin-right:6px;color:var(--muted);
      font-family:var(--mono);font-size:9.5px;letter-spacing:.16em}
    .c-count::before{margin-left:0}
    .bar-label{flex:0 0 120px}
  }
  @media (max-width:560px){
    .hero h1{font-size:21px}
    .stats{grid-template-columns:1fr 1fr}
    .stat{padding:10px 13px}
    .stat .v{font-size:22px}
    .bar-label{flex:0 0 96px;font-size:10px}
  }
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation:none!important;transition:none!important}
  }
</style>
</head>
<body>
<div class="glow" aria-hidden="true"></div>
<main class="wrap">
  <header class="hero">
    <span class="corner tl" aria-hidden="true"></span>
    <span class="corner tr" aria-hidden="true"></span>
    <span class="corner bl" aria-hidden="true"></span>
    <span class="corner br" aria-hidden="true"></span>
    <div class="hero-inner">
      <div class="kicker"><span class="pulse" aria-hidden="true"></span><span>CROSS-PROJECT</span><span class="sep">/</span><span>BOARD</span></div>
      <h1>跨项目 <span class="accent">仪表盘</span></h1>
      <div class="meta">扫描 ${dir} &#183; 共 ${totalProjects} 个项目 &#183; 生成 ${htmlEsc(now)}</div>
      <div class="stats">${statsHtml}</div>
    </div>
  </header>
  ${blockHtml}
  <section class="logsec" aria-labelledby="trend-title">
    <div class="sec-head"><h2 id="trend-title">📈 记录趋势</h2><div class="shown">按项目记录数</div></div>
    ${barHtml || '<div class="bar-row"><span class="bar-label">暂无项目</span></div>'}
  </section>
  <section class="logsec" aria-labelledby="overview-title">
    <div class="sec-head"><h2 id="overview-title">📊 项目总览</h2><div class="shown">${totalProjects} 个项目</div></div>
    <div class="table-wrap">
      <table>
        <caption class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">各项目阶段、焦点、阻塞与记录数</caption>
        <colgroup><col class="w-state"><col class="w-name"><col class="w-phase"><col><col><col class="w-count"><col class="w-time"></colgroup>
        <thead><tr><th scope="col">状态</th><th scope="col">项目</th><th scope="col">阶段</th><th scope="col">焦点</th><th scope="col">阻塞</th><th scope="col">记录</th><th scope="col">最后更新</th></tr></thead>
        <tbody>${projectRows || '<tr class="row"><td data-label="项目" colspan="7">暂无已接入项目</td></tr>'}</tbody>
      </table>
    </div>
  </section>
  <footer>自动生成 &#183; 来源各项目 .ai/status.json + .ai/log.jsonl &#183; 勿手动编辑</footer>
</main>
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
