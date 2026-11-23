/**
 * Cross-session handoff: build `.ai\SESSION_BOOT.md`, the "接棒提示词".
 *
 * The project already stores the two raw roles this needs:
 *   - event stream  -> `.ai\log.jsonl` (append-only; COMMLOG role)
 *   - current state -> `.ai\status.json` + `.ai\TASKS.md` (TASK_BOARD role)
 * What was missing is the small, deterministic boot file that tells a new
 * session what to read and what to report. This module renders it from the
 * existing files; it never invents facts the log/status do not contain, and it
 * never asks the model to read the whole log (only the last N records).
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readText, writeFileAtomic } from './atomic.js'
import { listProject } from './disciplines.js'

function readJson(path) {
  try { return JSON.parse(readText(path)) } catch { return null }
}

export function readRecords(root) {
  const text = readText(join(root, '.ai', 'log.jsonl'))
  const out = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* ai_check reports malformed rows */ }
  }
  return out
}

function oneLine(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function list(value) {
  if (Array.isArray(value)) return value.map((v) => oneLine(v, 120)).filter(Boolean)
  if (value === undefined || value === null || value === '') return []
  return [oneLine(value, 120)]
}

export function buildHandoff(root, { maxTail = 10 } = {}) {
  const status = readJson(join(root, '.ai', 'status.json'))
  const records = readRecords(root)
  const disciplines = listProject(root)
  const recent = records.slice(-Math.max(1, Math.min(Number(maxTail) || 10, 50)))
  return {
    root,
    project: status?.project || basename(root),
    generatedAt: new Date().toISOString(),
    hasStatus: Boolean(status),
    hasLog: records.length > 0,
    status: status
      ? {
        phase: status.phase || '',
        focus: status.focus || '',
        blockers: list(status.blockers),
        next: list(status.next),
        updated_at: status.updated_at || '',
        last_log_id: status.last_log_id || '',
      }
      : null,
    recent: recent.map((r) => ({
      id: r.id || '',
      ts: r.ts || '',
      action: r.action || '',
      status: r.status || '',
      summary: oneLine(r.summary),
    })),
    totalRecords: records.length,
    disciplines: {
      global: disciplines.global.length,
      globalEnabled: disciplines.global.filter((d) => d.enabled).length,
      project: disciplines.project.length,
      projectEnabled: disciplines.project.filter((d) => d.enabled).length,
      generated: disciplines.globalGenerated,
    },
    paths: {
      agents: join(root, 'AGENTS.md'),
      status: join(root, '.ai', 'status.json'),
      log: join(root, '.ai', 'log.jsonl'),
      tasks: join(root, 'TASKS.md'),
      boot: join(root, '.ai', 'SESSION_BOOT.md'),
      disciplines: join(root, '.ai', 'disciplines', 'disciplines.json'),
    },
  }
}

export function renderSessionBoot(packet) {
  const s = packet.status
  const lines = [
    '# 接棒提示词（SESSION_BOOT）',
    '',
    '<!-- dsh-ai-collab:session-boot:generated; 由插件自动生成，不要手改 -->',
    `> 生成时间：${packet.generatedAt}；项目：**${packet.project}**。`,
    '> 来源：`.ai/status.json`、`.ai/log.jsonl`、`.ai/disciplines/`。',
    '> 新会话请按 §1 顺序读取，然后按 §6 输出「继承摘要」，再开始本轮任务。',
    '',
    '## 1. 必读顺序',
    '',
    '1. 本文件（`SESSION_BOOT.md`）；',
    '2. `AGENTS.md`：§1 项目事实、§3 权限表、§8 纪律清单；',
    '3. `.ai/status.json`：当前状态快照；',
    `4. \`.ai/log.jsonl\` 最近 ${packet.recent.length} 条（§3 已摘录，需要细节再回读）；`,
    '5. `TASKS.md`（存在时）：任务记录清单；',
    '6. `.ai/disciplines/disciplines.json` 与启用规则（存在时）。',
    '',
    '## 2. 当前状态',
    '',
  ]
  if (!s) {
    lines.push('- `.ai/status.json` 缺失或不可解析：本项目可能尚未写入第一条状态。')
    lines.push('- 先跑 `.ai\\llm.cmd status` 或 `ai_init`，再做判断。')
  } else {
    lines.push(`- 阶段：${s.phase || '（未设置）'}`)
    lines.push(`- 焦点：${s.focus || '（未设置）'}`)
    lines.push(`- 阻塞：${s.blockers.length ? s.blockers.map((b) => `\`${b}\``).join('；') : '无'}`)
    lines.push(`- 下一步：${s.next.length ? s.next.map((n) => `\`${n}\``).join('；') : '（未设置）'}`)
    lines.push(`- 最近更新：${s.updated_at || '（未知）'}${s.last_log_id ? `（记录 \`${s.last_log_id}\`）` : ''}`)
  }
  if (packet.disciplines.global > 0 || packet.disciplines.project > 0) {
    lines.push(`- 纪律：全局 ${packet.disciplines.globalEnabled}/${packet.disciplines.global} 启用；项目 ${packet.disciplines.projectEnabled}/${packet.disciplines.project} 启用`)
  }
  lines.push('', `## 3. 最近记录（倒序，共 ${packet.totalRecords} 条）`, '')
  if (packet.recent.length === 0) {
    lines.push('（日志为空）')
  } else {
    lines.push('| 时间 | 类型 | 状态 | 摘要 | 记录 id |', '|---|---|---|---|---|')
    for (const r of [...packet.recent].reverse()) {
      lines.push(`| ${r.ts} | ${r.action} | ${r.status} | ${oneLine(r.summary, 160)} | \`${r.id}\` |`)
    }
  }
  lines.push('', '## 4. 纪律清单', '')
  if (packet.disciplines.global === 0 && packet.disciplines.project === 0) {
    lines.push('（尚未配置纪律模块；见 `AGENTS.md` §8）')
  } else {
    lines.push(`- 全局：${packet.disciplines.global} 个模块（${packet.disciplines.globalEnabled} 个启用），见 \`$DSH_HOME\\AGENTS.md\` 与 \`$DSH_HOME\\disciplines\\\`。`)
    lines.push(`- 项目：${packet.disciplines.project} 条规则（${packet.disciplines.projectEnabled} 条启用），见 \`.ai\\disciplines\\\` 与 \`AGENTS.md\` §8。`)
    lines.push('- 按项目卸载的全局纪律不会被 DSH 强制执行；项目规则只有“启用并内联”才真正生效。')
  }
  lines.push('', '## 5. 交接提示', '')
  const open = s?.next?.length ? s.next : []
  const blockers = s?.blockers?.length ? s.blockers : []
  if (blockers.length) lines.push(`- **先处理阻塞**：${blockers.map((b) => `\`${b}\``).join('；')}`)
  if (open.length) lines.push(`- **未完成事项**：${open.map((n) => `\`${n}\``).join('；')}`)
  if (!blockers.length && !open.length) lines.push('- 没有记录的阻塞或下一步；请从 `status.json` 的 `focus` 与最近记录判断。')
  lines.push('- 改文件前先确认 §3 权限表；日志只追加，不覆盖历史。')
  lines.push('', '## 6. 继承摘要（新会话必须输出）', '')
  lines.push('用 5–8 行回答，事实必须来自上述文件：')
  lines.push('1. 这个项目做什么、当前阶段是什么；')
  lines.push('2. 最近 3 条记录分别做了什么（带验证结果）；')
  lines.push('3. 当前阻塞、风险或未完成项；')
  lines.push('4. 下一步建议（1–3 条，可执行）；')
  lines.push('5. 需要用户确认的问题（没有就写“无”）。')
  lines.push('')
  return lines.join('\n')
}

export function writeSessionBoot(root, opts = {}) {
  const packet = buildHandoff(root, opts)
  const text = renderSessionBoot(packet)
  const path = packet.paths.boot
  writeFileAtomic(path, text)
  return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8'), records: packet.totalRecords, recent: packet.recent.length }
}

export function inheritPrompt(root) {
  const boot = join(root, '.ai', 'SESSION_BOOT.md')
  return `请读取项目根 \`${root}\` 下的 \`.ai/SESSION_BOOT.md\`，按其中 §1 的顺序读取文件，然后按 §6 输出「继承摘要」；在摘要末尾列出需要我确认的问题。`
}

export function sessionBootExists(root) {
  return existsSync(join(root, '.ai', 'SESSION_BOOT.md'))
}
