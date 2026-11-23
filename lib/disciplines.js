/**
 * Discipline registry: global modules + per-project rules.
 *
 * Two layers, deliberately separated:
 *
 * - **Global** (`$DSH_HOME\disciplines\`): modules that make up the user-level
 *   `$DSH_HOME\AGENTS.md`. DSH injects that file into every session, so a
 *   module can be enabled/disabled for all projects, but a single project
 *   cannot opt out of it (the injection is not mediated by this plugin).
 * - **Project** (`<root>\.ai\disciplines\`): rules that are rendered into the
 *   `generated` zone of the project `AGENTS.md` (§8). "Enabled" means the rule
 *   body is inlined there, so the discipline is actually in the prompt; a
 *   disabled rule is only listed by id and is not in effect.
 *
 * The global file is generated: a marker line says so, and every render backs
 * up the previous content first. The plugin never rewrites a global file that
 * was not produced by this renderer unless the caller explicitly migrates it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { backupFile, readText, fileStamp, writeFileAtomic } from './atomic.js'

export const GLOBAL_MARK = 'dsh-ai-collab:global:generated'
export const PROJECT_RULE_RE = /<!-- dsh-ai-collab:discipline:([a-z0-9][a-z0-9-]*):start -->\n?([\s\S]*?)<!-- dsh-ai-collab:discipline:\1:end -->/g
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export function globalHome() {
  const env = process.env.DSH_HOME
  if (env) return env
  return join(homedir(), '.dsh')
}

export function globalDir() { return join(globalHome(), 'disciplines') }
export function globalAgentsPath() { return join(globalHome(), 'AGENTS.md') }
export function globalRegistryPath() { return join(globalDir(), 'disciplines.json') }
export function projectDir(root) { return join(root, '.ai', 'disciplines') }
export function projectRegistryPath(root) { return join(projectDir(root), 'disciplines.json') }
export function projectRulesDir(root) { return join(projectDir(root), 'rules') }

export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

function readJson(path) {
  try { return JSON.parse(readText(path)) } catch { return null }
}

function asArray(value) { return Array.isArray(value) ? value : [] }

/** Validate/normalise a registry object read from disk; never throws on bad rows. */
export function normaliseRegistry(raw, kind) {
  const listKey = kind === 'global' ? 'modules' : 'rules'
  const rows = asArray(raw?.[listKey]).map((row, index) => {
    const id = String(row?.id ?? '').trim()
    if (!ID_RE.test(id)) return null
    const file = String(row?.file ?? `${id}.md`).replace(/\\/g, '/')
    if (file.includes('..') || file.startsWith('/') || /^[a-zA-Z]:/.test(file)) return null
    return {
      id,
      title: String(row?.title ?? id).trim() || id,
      enabled: row?.enabled !== false,
      priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : index * 10,
      file,
      description: String(row?.description ?? '').trim(),
    }
  }).filter(Boolean)
  // Stable order: priority, then id. Keep duplicate ids out (first wins).
  const seen = new Set()
  const unique = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
  unique.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return { version: 1, [listKey]: unique }
}

function writeRegistry(path, registry) {
  writeFileAtomic(path, `${JSON.stringify(registry, null, 2)}\n`)
}

/** Parse `## N. title` sections out of an AGENTS.md that has no registry yet. */
export function parseSections(text) {
  const starts = [...String(text ?? '').matchAll(/^##[ \t]+\S/gm)].map((m) => m.index)
  const sections = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : text.length
    const body = text.slice(start, end)
    const heading = body.split('\n', 1)[0].replace(/^##\s+/, '').trim()
    const m = /^(\d+)[.、]/.exec(heading)
    sections.push({ id: m ? `g${m[1]}` : `g${i}`, title: heading, body })
  }
  return sections
}

/** Load the global registry and every module body. */
export function loadGlobal() {
  const dir = globalDir()
  const agentsPath = globalAgentsPath()
  const rawText = readText(agentsPath)
  const registryRaw = readJson(globalRegistryPath())
  const registry = normaliseRegistry(registryRaw ?? {}, 'global')
  const generated = rawText.includes(GLOBAL_MARK)
  const modules = registry.modules.map((row) => ({
    ...row,
    body: readText(join(dir, row.file)),
    hash: hashText(readText(join(dir, row.file))),
  }))
  let fallback = []
  if (!registryRaw && rawText) {
    fallback = parseSections(rawText).map((s) => ({
      id: s.id, title: s.title, enabled: true, priority: 0, file: '', body: s.body, hash: hashText(s.body),
    }))
  }
  return { dir, agentsPath, registry, modules, fallback, generated, exists: existsSync(agentsPath) }
}

/** Load project rules and bodies. */
export function loadProject(root) {
  const registry = normaliseRegistry(readJson(projectRegistryPath(root)) ?? {}, 'project')
  const rules = registry.rules.map((row) => {
    const body = readText(join(projectRulesDir(root), row.file))
    return { ...row, body, hash: hashText(body) }
  })
  return { registry, rules }
}

export function renderGlobal(preamble, modules) {
  const body = modules.filter((m) => m.enabled && m.body).map((m) => m.body.replace(/\s+$/, '') + '\n').join('\n')
  return `${preamble.replace(/\s+$/, '')}\n\n${body}`
}

/**
 * One-time migration: split the current global AGENTS.md into modules.
 * Verifies that preamble + sections reproduce the original byte-for-byte
 * before writing anything; the only intended diff is the generated marker.
 */
export function migrateGlobal({ force = false } = {}) {
  const agentsPath = globalAgentsPath()
  if (!existsSync(agentsPath)) throw new Error(`找不到全局纪律文件: ${agentsPath}`)
  const dir = globalDir()
  if (existsSync(globalRegistryPath()) && !force) {
    throw new Error(`全局纪律模块已存在: ${globalRegistryPath()}（如需重建请传 force=true，会先备份）`)
  }
  const originalRaw = readText(agentsPath)
  // Re-running with force must not stack markers: strip the one we added last time.
  const hadMarker = originalRaw.startsWith(`<!-- ${GLOBAL_MARK}`)
  const original = hadMarker
    ? originalRaw.slice(originalRaw.indexOf('\n') + 1)
    : originalRaw
  const sections = parseSections(original)
  if (sections.length === 0) throw new Error('全局 AGENTS.md 中没有 “## ” 小节，无法模块化')

  const firstStart = original.indexOf(sections[0].body.slice(0, 40))
  const preambleRaw = firstStart > 0 ? original.slice(0, firstStart) : ''
  const rebuilt = preambleRaw + sections.map((s) => s.body).join('')
  if (rebuilt !== original) throw new Error('迁移自检失败：拆分后的内容无法逐字节还原原文件，已中止')

  const backupDir = join(dir, '_backup')
  const backup = backupFile(agentsPath, backupDir, { prefix: 'AGENTS', keep: 20 })
  mkdirSync(dir, { recursive: true })

  const marker = `<!-- ${GLOBAL_MARK}; 由 ai_discipline 管理，手改会在下次渲染时被覆盖 -->\n`
  const preamble = marker + preambleRaw
  const modules = sections.map((section, index) => {
    const id = `g${index}`
    const file = `${id}.md`
    writeFileAtomic(join(dir, file), section.body.replace(/\s+$/, '') + '\n')
    return { id, title: section.title, enabled: true, priority: index, file }
  })
  writeFileAtomic(join(dir, '_preamble.md'), preamble)
  writeRegistry(globalRegistryPath(), { version: 1, modules })
  // First migration writes the original text plus the marker only: no
  // re-serialisation difference, so `git diff` is exactly one added line.
  const rendered = marker + original
  writeFileAtomic(agentsPath, rendered)
  return {
    ok: true, dir, backup, agentsPath,
    modules: modules.map((m) => m.id),
    bytes: Buffer.byteLength(rendered, 'utf8'),
    sameAsOriginal: !hadMarker,
  }
}

/** Render the global AGENTS.md from its registry (backs up first). */
export function renderGlobalFile() {
  const state = loadGlobal()
  if (state.modules.length === 0) throw new Error('全局纪律模块为空或注册表不可读，拒绝重写 AGENTS.md')
  const preamble = readText(join(state.dir, '_preamble.md')) || `<!-- ${GLOBAL_MARK} -->\n`
  const rendered = renderGlobal(preamble, state.modules)
  const backup = backupFile(state.agentsPath, join(state.dir, '_backup'), { prefix: 'AGENTS', keep: 20 })
  writeFileAtomic(state.agentsPath, rendered)
  return { ok: true, path: state.agentsPath, backup, bytes: Buffer.byteLength(rendered, 'utf8'), enabled: state.modules.filter((m) => m.enabled).length, disabled: state.modules.filter((m) => !m.enabled).length }
}

export function setGlobalEnabled(id, enabled) {
  const state = loadGlobal()
  if (state.registry.modules.length === 0) throw new Error('全局纪律尚未模块化；请先执行 global-migrate')
  const target = state.registry.modules.find((m) => m.id === id)
  if (!target) throw new Error(`全局纪律不存在: ${id}`)
  target.enabled = Boolean(enabled)
  writeRegistry(globalRegistryPath(), state.registry)
  return target
}

export function addGlobalModule({ id, title, body, priority }) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('id 必须为 2–41 位小写字母/数字/连字符')
  if (!String(title ?? '').trim()) throw new Error('global-add 需要 title')
  if (!String(body ?? '').trim()) throw new Error('global-add 需要 body')
  const state = loadGlobal()
  if (state.registry.modules.some((m) => m.id === id)) throw new Error(`全局纪律已存在: ${id}`)
  if (state.registry.modules.length === 0) throw new Error('全局纪律尚未模块化；请先执行 global-migrate')
  const file = `${id}.md`
  const text = `## ${String(title).trim()}\n\n${String(body).trim()}\n`
  writeFileAtomic(join(state.dir, file), text)
  state.registry.modules.push({
    id, title: String(title).trim(), enabled: true,
    priority: Number.isFinite(Number(priority)) ? Number(priority) : state.registry.modules.length * 10,
    file,
  })
  writeRegistry(globalRegistryPath(), state.registry)
  return { id, file, title: String(title).trim() }
}

export function removeGlobalModule({ id, archive = true }) {
  const state = loadGlobal()
  const target = state.registry.modules.find((m) => m.id === id)
  if (!target) throw new Error(`全局纪律不存在: ${id}`)
  state.registry.modules = state.registry.modules.filter((m) => m.id !== id)
  writeRegistry(globalRegistryPath(), state.registry)
  if (archive) {
    const src = join(state.dir, target.file)
    if (existsSync(src)) {
      const destDir = join(state.dir, '_archive')
      mkdirSync(destDir, { recursive: true })
      renameSync(src, join(destDir, `${basename(target.file, '.md')}.${fileStamp()}.md`))
    }
  }
  return target
}

/** Text fragments for AGENTS.md §8 (table + inlined enabled project rules). */
export function renderProjectSection(root) {
  const global = loadGlobal()
  const globals = global.modules.length > 0 ? global.modules : global.fallback
  const project = loadProject(root)

  const rows = ['| 编号 | 范围 | 纪律 | 状态 | 来源 |', '|---|---|---|---|---|']
  for (const m of globals) {
    const display = `G${m.id.replace(/^g/, '')}`
    const source = m.file ? `$DSH_HOME\\disciplines\\${m.file.replace(/\//g, '\\')}` : '$DSH_HOME\\AGENTS.md'
    rows.push(`| ${display} | 全局 | ${m.title.replace(/\|/g, '\\|')} | ${m.enabled ? '启用' : '停用'} | \`${source}\` |`)
  }
  for (const r of project.rules) {
    const display = `P-${r.id.replace(/^p-/, '')}`
    const source = `.ai\\disciplines\\rules\\${r.file.replace(/\//g, '\\')}`
    rows.push(`| ${display} | 项目 | ${r.title.replace(/\|/g, '\\|')} | ${r.enabled ? '启用' : '停用'} | \`${source}\` |`)
  }
  if (globals.length === 0 && project.rules.length === 0) rows.push('| — | — | （暂无纪律清单） | — | — |')

  const blocks = []
  for (const r of project.rules) {
    if (!r.enabled) continue
    const display = `P-${r.id.replace(/^p-/, '')}`
    const body = r.body.replace(/\s+$/, '').replace(/^#{1,3}\s+.*\n+/, '')
    blocks.push(`<!-- dsh-ai-collab:discipline:${r.id}:start -->\n### ${display} · ${r.title}\n\n${body}\n<!-- dsh-ai-collab:discipline:${r.id}:end -->`)
  }
  return {
    table: rows.join('\n'),
    rules: blocks.length > 0 ? blocks.join('\n\n') : '（暂无启用的项目纪律）',
    counts: { global: globals.length, project: project.rules.length, enabled: project.rules.filter((r) => r.enabled).length },
    globals: globals.map((m) => ({ id: m.id, title: m.title, enabled: m.enabled, hash: m.hash || '' })),
    project: project.rules.map((r) => ({ id: r.id, title: r.title, enabled: r.enabled, hash: r.hash })),
  }
}

/** Compare AGENTS.md §8 against the registry; returns drift messages. */
export function auditProject(root, agentsText) {
  const drift = []
  const project = loadProject(root)
  const present = new Set([...String(agentsText ?? '').matchAll(PROJECT_RULE_RE)].map((m) => m[1]))
  for (const rule of project.rules) {
    if (rule.enabled && !present.has(rule.id)) drift.push(`规则 ${rule.id} 已启用但未内联进 AGENTS.md`)
    if (!rule.enabled && present.has(rule.id)) drift.push(`规则 ${rule.id} 已停用但仍内联在 AGENTS.md`)
  }
  for (const id of present) {
    if (!project.rules.some((r) => r.id === id)) drift.push(`AGENTS.md 内联了注册表不存在的规则 ${id}`)
  }
  return drift
}

export function listProject(root) {
  const project = loadProject(root)
  const global = loadGlobal()
  return {
    project: project.rules.map((r) => ({ id: r.id, title: r.title, enabled: r.enabled, file: r.file, hash: r.hash })),
    global: (global.modules.length ? global.modules : global.fallback).map((m) => ({ id: m.id, title: m.title, enabled: m.enabled, file: m.file, hash: m.hash || '' })),
    globalGenerated: global.generated,
    globalRegistry: global.modules.length > 0,
  }
}
