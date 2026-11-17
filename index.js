/**
 * dsh-ai-collab — AI 协作层 v2 的 DSH 插件（原型；默认不安装）
 *
 * 作用：把 .ai/ 协作层的常用动作暴露成原生工具，并在需要时自动为工作区接入骨架。
 *      纪律本身仍由 $DSH_HOME/AGENTS.md 全局注入，本插件只补“能力”和“自动化”。
 *
 * 两个安装前必须核实的 API 点（用 Creator 模式的 cordis_inspect_query 查）：
 *   1) defineTool 的 output.render 返回值契约（当前实现返回纯文本字符串）；
 *   2) 'tools' 是否就是 ctx.tools 的注入名（当前按官方示例 inject = ['tools']）。
 * 插件异常会影响 Host 启动，所以首次安装请用 --patch 隔离验证，见 README。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { normalizeConfig } from './lib/config.js'
import { writeTasks } from './lib/tasks.js'

export const name = 'ai-collab'
// Only `tools` is required. `workingDirectory` is used when present
// (`ctx.workingDirectory?.ensure` at call time) but must not gate activation:
// a static inject of a service a host does not provide leaves the plugin
// pending forever, and the tools would never register.
export const inject = ['tools']

/** Scaffolding runs packaged PowerShell 5.1 scripts, which are Windows-only. */
const SCAFFOLD_SUPPORTED = process.platform === 'win32'

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version || 'unknown' } catch { return 'unknown' }
})()

// ---------------------------------------------------------------- host plumbing

/**
 * 解析 $DSH_HOME。GUI 启动（explorer → app.exe）时宿主环境里可能没有 DSH_HOME，
 * 此时退回 ~/.dsh；否则心跳与工具日志会静默不写，重启后无法验证插件是否加载。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return { home: fromEnv, source: 'env' }
  try {
    const guess = join(homedir(), '.dsh')
    return { home: guess, source: existsSync(guess) ? 'homedir' : 'homedir-missing' }
  } catch {
    return { home: '', source: 'none' }
  }
}

const LOG_ROTATE_BYTES = 256 * 1024

/** Best-effort rotation: `name` becomes `name.1` once it exceeds the cap. */
function rotateLog(path) {
  try {
    if (!existsSync(path) || statSync(path).size < LOG_ROTATE_BYTES) return
    const previous = `${path}.1`
    if (existsSync(previous)) rmSync(previous, { force: true })
    renameSync(path, previous)
  } catch { /* rotation is best effort; appending still works */ }
}

/** 追加一行到 $DSH_HOME/logs/<name>；失败不抛，返回是否写入。 */
function appendLog(name, line) {
  const { home } = dshHome()
  if (!home) return false
  try {
    const dir = join(home, 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    rotateLog(file)
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * dsh-tools 随宿主打包在 app.asar 内；插件装在 asar 之外（F:\... 或 profile 外链）时
 * 裸包名解析不到，必须按宿主实际位置以绝对 file URL 加载。
 */
function asarRoots() {
  const roots = new Set()
  const take = (candidate) => {
    if (!candidate) return
    const m = String(candidate).match(/^(.*[\\/]app\.asar)(?:[\\/]dsh)?[\\/]?$/i)
    if (m) roots.add(m[1])
  }
  if (process.resourcesPath) take(join(process.resourcesPath, 'app.asar'))
  try { take(join(dirname(process.execPath), 'resources', 'app.asar')) } catch { /* 取不到就跳过 */ }
  for (const arg of process.argv.slice(1)) take(arg)
  return [...roots]
}

function toolsCandidates() {
  const specs = ['@deepseek-ai/dsh-tools']
  for (const root of asarRoots()) {
    specs.push(pathToFileURL(join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href)
  }
  return [...new Set(specs)]
}

/** 按候选顺序加载 dsh-tools，返回命中的 spec 与失败明细（失败明细会落盘）。 */
async function loadToolsApi() {
  const tried = []
  for (const spec of toolsCandidates()) {
    try {
      const api = await import(spec)
      if (typeof api.defineTool === 'function') return { api, spec, tried }
      tried.push(`${spec} (no defineTool export)`)
    } catch (error) {
      tried.push(`${spec} -> ${error.code || error.name}: ${String(error.message).split('\n')[0]}`)
    }
  }
  return { api: null, spec: '', tried }
}

const STATUSES = ['ok', 'partial', 'blocked', 'todo', 'failed']
const ACTIONS = [
  'task_start', 'task_done', 'fix', 'diagnosis', 'build', 'commit',
  'doc', 'review', 'rollback', 'correction', 'maintenance', 'handoff'
]

// ---------------------------------------------------------------- helpers

function nowIso() {
  const d = new Date()
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
}

function aiDir(root) { return join(root, '.ai') }
function logPath(root) { return join(aiDir(root), 'log.jsonl') }
function statusPath(root) { return join(aiDir(root), 'status.json') }
function hasFramework(root) { return existsSync(logPath(root)) || existsSync(join(aiDir(root), 'llm.ps1')) }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0)
}

function recordErrors(rec, lineNo) {
  const out = []
  const push = (m) => out.push(lineNo > 0 ? `第 ${lineNo} 行: ${m}` : m)
  if (!rec || typeof rec !== 'object') { push('不是 JSON 对象'); return out }
  if (typeof rec.id !== 'string' || rec.id.length < 8) push('缺少 id 或过短')
  if (typeof rec.ts !== 'string' || !/[+-]\d{2}:\d{2}$|Z$/.test(rec.ts)) push('ts 缺少时区或格式非法')
  if (typeof rec.tool !== 'string' || !rec.tool.trim()) push('缺少 tool')
  if (typeof rec.summary !== 'string' || !rec.summary.trim()) push('缺少 summary')
  if (!STATUSES.includes(rec.status)) push(`status 非法: ${rec.status}`)
  if (rec.action !== undefined && !ACTIONS.includes(rec.action)) push(`action 非法: ${rec.action}`)
  if ((rec.status === 'blocked' || rec.status === 'failed') && !rec.issue) push('blocked/failed 必须带 issue')
  return out
}

function appendRecord(root, input) {
  const rec = {
    id: input.id || newId(),
    ts: input.ts || nowIso(),
    tool: input.tool || 'deepseek-harness',
    actor: input.actor || 'ai',
    status: input.status || 'ok',
    summary: input.summary || ''
  }
  if (input.action) rec.action = input.action
  for (const key of ['files_modified', 'files_read', 'issue', 'next', 'verification', 'build', 'tests', 'commands', 'firmware_version', 'vcs_rev', 'refs', 'tags', 'corrects', 'agent']) {
    if (input[key] !== undefined && input[key] !== null) rec[key] = input[key]
  }
  const errors = recordErrors(rec, 0)
  if (errors.length > 0) throw new Error(`记录校验失败，未写入: ${errors.join('; ')}`)

  mkdirSync(aiDir(root), { recursive: true })
  appendFileSync(logPath(root), JSON.stringify(rec) + '\n', 'utf8')

  const st = readJson(statusPath(root))
  if (st) {
    st.last_log_ts = rec.ts
    st.last_log_id = rec.id
    st.updated_at = nowIso()
    if (rec.next) st.next = [rec.next]
    if (rec.status === 'blocked' || rec.status === 'failed') {
      const list = Array.isArray(st.blockers) ? st.blockers : []
      st.blockers = [...new Set([rec.issue, ...list].filter(Boolean))]
    }
    try { writeFileSync(statusPath(root), JSON.stringify(st, null, 2) + '\n', 'utf8') } catch { /* 状态刷新失败不影响日志 */ }
  }
  return rec
}

function spawnEnsure(root, config, extraArgs = []) {
  const script = config.initScript || join(PKG_ROOT, 'ai-ensure.ps1')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, ...extraArgs]
  if (!existsSync(script)) return { started: false, reason: `找不到同步脚本: ${script}` }
  if (!SCAFFOLD_SUPPORTED) {
    appendLog('ai-collab-ensure.log', `root=${root} skipped=unsupported-platform(${process.platform})`)
    return { started: false, reason: `unsupported-platform: ${process.platform}` }
  }
  // 注意：这里不能加 detached —— 在 Electron/无控制台的宿主里 detached 子进程会立刻消失，
  // ai-ensure 根本不执行（表现为 ai_init/autoInit “静默无效”）。同步取回输出才能验证结果。
  try {
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    const done = new Promise((resolve) => {
      child.on('error', (e) => resolve({ ok: false, error: `${e.code || e.name}: ${e.message}` }))
      child.on('close', (code) => resolve({ ok: code === 0, code, out: out.trim(), err: err.trim().slice(0, 500) }))
    })
    done.then((r) => {
      appendLog('ai-collab-ensure.log', `root=${root} code=${r.code ?? '-'} ${r.ok ? 'ok' : 'fail'} ${(r.out || r.err || r.error || '').slice(0, 300)}`)
    })
    return { started: true, script, pid: child.pid, done }
  } catch (error) {
    appendLog('ai-collab-ensure.log', `root=${root} spawn-throw ${error?.message || error}`)
    return { started: false, reason: String(error?.message || error) }
  }
}

/** 从 ai-ensure 的输出里取最后一行 JSON（其余是 PowerShell 噪声）。 */
function parseEnsureOutput(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* 继续往前找 */ }
  }
  return null
}

const lastRefresh = new Map()

/** Coalesce repeated refreshes of the same root (two sessions can log at once). */
function recentlyRefreshed(root, key, windowMs) {
  const id = `${root}::${key}`
  const now = Date.now()
  const last = lastRefresh.get(id) || 0
  if (now - last < windowMs) return true
  lastRefresh.set(id, now)
  return false
}

// 写日志后顺带刷新看板（仅当上级目录已有 .ai\board.md；走包内 ai-ensure，不执行工作区脚本）
function maybeRefreshBoard(root) {
  try {
    if (!existsSync(join(dirname(root), '.ai', 'board.md'))) return
    if (recentlyRefreshed(root, 'board', 3000)) return
    spawnEnsure(root, {}, ['-NoAgents'])
  } catch { /* 看板刷新失败不影响记录 */ }
}

/**
 * 写日志后刷新任务清单（仅当 .ai\tasks-enabled 存在）。
 * 进程内渲染：不执行工作区自带的 .ai/llm.ps1，避免仓库脚本被插件执行。
 */
function refreshTasks(root) {
  try {
    if (!existsSync(join(root, '.ai', 'tasks-enabled'))) return
    const { written, count } = writeTasks(root, nowIso())
    if (!written) return
    if (count === 0) appendLog('ai-collab-tasks.log', `root=${root} count=0`)
  } catch (error) {
    appendLog('ai-collab-tasks.log', `root=${root} throw ${error?.message || error}`)
  }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, config = {}) {
  const { autoInit, maxTail, initScript, warnings } = normalizeConfig(config)
  const opts = { autoInit, maxTail, initScript }
  if (warnings.length > 0) {
    appendLog('ai-collab-config.log', warnings.join(' | '))
    for (const warning of warnings) ctx.logger?.warn?.(`ai-collab config: ${warning}`)
  }

  // 启动心跳：确认插件是否被 Host 加载（$DSH_HOME/logs/ai-collab-boot.log）
  // DSH_HOME 缺失时退回 ~/.dsh，保证 GUI 启动方式下也有可验证的落盘信号。
  const homeInfo = dshHome()
  const beat = appendLog('ai-collab-boot.log', `version=${PKG_VERSION} autoInit=${opts.autoInit} home=${homeInfo.source}`)
  if (!beat) ctx.logger?.warn?.('ai-collab: 心跳写入失败（找不到可写的 $DSH_HOME）', homeInfo)

  // 1) 会话创建时按需接入工作区（默认关闭，只有 config.autoInit=true 才写盘）
  ctx.effect(() => {
    if (!opts.autoInit) return () => {}
    const inFlight = new Set()
    const handler = async (session) => {
      let root = ''
      try {
        root = session?.cwd || session?.workspace
        if (!root) return
        if (!SCAFFOLD_SUPPORTED) {
          appendLog('ai-collab-ensure.log', `root=${root} skipped=unsupported-platform(${process.platform})`)
          return
        }
        if (inFlight.has(root)) return
        inFlight.add(root)
        // 是否接入由 ai-ensure 判断（排除临时/系统目录），此处不再重复过滤
        const result = spawnEnsure(root, opts)
        if (result.done) {
          const finished = await result.done
          ctx.logger?.info?.('ai-collab autoInit', { root, ok: finished.ok, parsed: parseEnsureOutput(finished.out) })
        }
      } catch (error) {
        // 任何异常都不能抛回 Host，否则会影响会话创建
        appendLog('ai-collab-ensure.log', `autoInit-throw root=${root} ${error?.message || error}`)
        ctx.logger?.warn?.('ai-collab autoInit failed', error)
      } finally {
        if (root) inFlight.delete(root)
      }
    }
    try {
      const off = ctx.on('session/created', handler, { global: true })
      return typeof off === 'function' ? off : () => {}
    } catch (error) {
      ctx.logger?.warn?.('ai-collab: session/created hook unavailable', error)
      return () => {}
    }
  })

  // 2) 工具：加载 dsh-tools 后注册；失败要落盘，不能只留一条 warn
  ctx.effect(() => {
    let disposed = false
    loadToolsApi().then(({ api, spec, tried }) => {
      if (disposed) return
      if (!api) {
        appendLog('ai-collab-tools.log', `load-failed tried=${tried.join(' | ')}`)
        ctx.logger?.warn?.('ai-collab: 未能加载 @deepseek-ai/dsh-tools，工具未注册', tried)
        return
      }
      try {
        registerTools(ctx, opts, api.defineTool, spec)
      } catch (error) {
        appendLog('ai-collab-tools.log', `register-failed spec=${spec} ${error?.message || error}`)
        ctx.logger?.warn?.('ai-collab: 工具注册失败', error)
      }
    }).catch((error) => {
      appendLog('ai-collab-tools.log', `load-error ${error?.message || error}`)
      ctx.logger?.warn?.('ai-collab: 工具加载异常', error)
    })
    return () => { disposed = true }
  })
}

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function logToolRegistration(names, spec) {
  appendLog('ai-collab-tools.log', `tools=${names.join(',')} spec=${spec} version=${PKG_VERSION}`)
}

function registerTools(ctx, opts, defineTool, spec) {
  const registered = []
  // workingDirectory is read loosely so a host without the service still
  // activates the plugin (ctx.get(name, false) returns undefined instead of
  // throwing); resolution then falls back to the process cwd.
  const workingDirectory = () => {
    try {
      if (typeof ctx.get === 'function') return ctx.get('workingDirectory', false)
    } catch { /* fall through */ }
    try { return ctx.workingDirectory } catch { return undefined }
  }
  // 会话工作区：优先用 workingDirectory 服务按 agent 解析，缺省回退到进程 cwd
  const rootOf = async (exec) => {
    try {
      const wd = workingDirectory()
      if (exec?.agent && wd?.ensure) {
        const dir = await wd.ensure(exec.agent, exec.signal)
        if (typeof dir === 'string' && dir.length > 0) return dir
      }
    } catch { /* 服务不可用时回退 */ }
    return process.cwd()
  }
  // DSH 契约：output.render 必须返回内容块数组；schema 用值 schema DSL 的 json 节点
  const output = { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }

  registered.push('ai_status')
  ctx.tools.register(defineTool({
    name: 'ai_status',
    description: '读取 .ai/status.json 与最近日志，用于接手项目（开工第一步）。',
    parameters: {},
    output,
    async execute(args, exec) {
      const r = await rootOf(exec)
      const st = readJson(statusPath(r))
      const lines = readLines(logPath(r))
      return {
        root: r,
        hasFramework: hasFramework(r),
        status: st,
        recent: lines.slice(-opts.maxTail).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
      }
    }
  }))

  registered.push('ai_log')
  ctx.tools.register(defineTool({
    name: 'ai_log',
    description: '向 .ai/log.jsonl 追加一条记录（只追加；blocked/failed 必须给 issue）。',
    parameters: {
      summary: { type: 'string', description: '一句话结论（做了什么 + 结果）', required: true },
      action: { type: 'string', enum: ACTIONS },
      status: { type: 'string', enum: STATUSES },
      tool: { type: 'string' },
      issue: { type: 'string', description: 'blocked/failed 必填' },
      next: { type: 'string' },
      verification: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } }
    },
    output,
    async execute(args, exec) {
      const r = await rootOf(exec)
      const rec = appendRecord(r, args)
      refreshTasks(r)
      maybeRefreshBoard(r)
      return rec
    }
  }))

  registered.push('ai_check')
  ctx.tools.register(defineTool({
    name: 'ai_check',
    description: '校验 .ai/log.jsonl（必填字段/枚举/ts 单调/id 唯一）与 status.json 的可解析性。',
    parameters: {},
    output,
    async execute(args, exec) {
      const r = await rootOf(exec)
      const errors = []
      const ids = new Set()
      let prev = null
      readLines(logPath(r)).forEach((line, index) => {
        let rec
        try { rec = JSON.parse(line) } catch { errors.push(`第 ${index + 1} 行: 不是合法 JSON`); return }
        for (const e of recordErrors(rec, index + 1)) errors.push(e)
        if (ids.has(rec.id)) errors.push(`第 ${index + 1} 行: id 重复`)
        ids.add(rec.id)
        const t = Date.parse(rec.ts)
        if (!Number.isNaN(t)) {
          if (prev !== null && t < prev) errors.push(`第 ${index + 1} 行: ts 倒退`)
          prev = t
        }
      })
      if (!readJson(statusPath(r))) errors.push('status.json 缺失或不可解析')
      return { root: r, records: readLines(logPath(r)).length, errors }
    }
  }))

  registered.push('ai_board')
  ctx.tools.register(defineTool({
    name: 'ai_board',
    description: '汇总同级项目的 .ai/status.json（只读，不写 board.md）。',
    parameters: {},
    output,
    async execute(args, exec) {
      const parent = dirname(await rootOf(exec))
      const rows = []
      for (const entry of readdirSafe(parent)) {
        if (entry.startsWith('.') || entry.startsWith('_')) continue
        const st = readJson(join(parent, entry, '.ai', 'status.json'))
        if (!st) continue
        rows.push({
          project: st.project || entry,
          dir: entry,
          phase: st.phase || '',
          focus: st.focus || '',
          blockers: st.blockers || [],
          next: st.next || [],
          updated_at: st.updated_at || ''
        })
      }
      return { scanned: parent, projects: rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) }
    }
  }))

  registered.push('ai_init')
  ctx.tools.register(defineTool({
    name: 'ai_init',
    description: '接入并同步当前工作区：缺 .ai 则创建，框架副本/AGENTS.md 过期则更新，看板过期则刷新（幂等）。',
    parameters: { root: { type: 'string', description: '目标工作区，缺省为会话 cwd' } },
    output,
    async execute(args, exec) {
      const target = args?.root || await rootOf(exec)
      if (!SCAFFOLD_SUPPORTED) {
        return { root: target, started: false, reason: `unsupported-platform: ${process.platform}` }
      }
      // 总是跑一次 ensure：已接入时它会同步过期文件/AGENTS/看板，未接入时创建骨架
      const handle = spawnEnsure(target, opts)
      if (!handle.started) return { root: target, started: false, reason: handle.reason }
      const finished = await handle.done
      // 只返回可 JSON 无损序列化的字段（undefined 会让工具结果校验失败）
      const payload = {
        root: target,
        started: true,
        script: handle.script,
        exit: finished.code ?? null,
        ok: finished.ok === true,
        result: parseEnsureOutput(finished.out),
      }
      if (finished.err) payload.stderr = finished.err.slice(0, 500)
      if (finished.error) payload.error = finished.error
      return payload
    }
  }))

  logToolRegistration(registered, spec)
}

// 仅供测试与调试：不要在插件内部依赖这些内部函数。
export const __internals = { recordErrors, appendRecord, readLines, nowIso, newId, refreshTasks, SCAFFOLD_SUPPORTED }
