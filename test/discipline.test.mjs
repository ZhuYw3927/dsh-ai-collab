import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../lib/atomic.js'
import { withLock } from '../lib/lock.js'
import {
  normaliseRegistry, migrateGlobal, loadGlobal, renderGlobalFile, setGlobalEnabled,
  renderProjectSection, auditProject, loadProject,
} from '../lib/disciplines.js'
import { writeSessionBoot, buildHandoff } from '../lib/handoff.js'

const temp = (prefix) => mkdtempSync(join(tmpdir(), `dsh-ai-${prefix}-`))

test('writeFileAtomic 写入完整内容且不残留临时文件', () => {
  const dir = temp('atomic')
  const file = join(dir, 'a.json')
  writeFileAtomic(file, '{"x":1}\n')
  assert.equal(readFileSync(file, 'utf8'), '{"x":1}\n')
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
})

test('withLock 在成功与抛错后都释放锁', () => {
  const dir = temp('lock')
  const lock = join(dir, '.lock')
  assert.equal(withLock(lock, () => 42), 42)
  assert.equal(existsSync(lock), false)
  assert.throws(() => withLock(lock, () => { throw new Error('boom') }), /boom/)
  assert.equal(existsSync(lock), false)
})

test('normaliseRegistry 过滤非法 id 并按 priority 排序', () => {
  const out = normaliseRegistry({
    rules: [
      { id: 'b-rule', title: 'B', priority: 20 },
      { id: 'a-rule', title: 'A', priority: 10 },
      { id: 'Bad Id', title: 'bad' },
      { id: 'a-rule', title: 'dup' },
    ],
  }, 'project')
  assert.deepEqual(out.rules.map((r) => r.id), ['a-rule', 'b-rule'])
})

test('migrateGlobal 备份并保留原文字节，可停用再启用模块', () => {
  const home = temp('dsh')
  const original = '# 纪律\n\n## 0. 第 0 步\n\nrun ensure\n\n## 1. 对齐\n\nask first\n'
  writeFileSync(join(home, 'AGENTS.md'), original, 'utf8')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const r = migrateGlobal()
    assert.equal(r.modules.length, 2)
    const after = readFileSync(join(home, 'AGENTS.md'), 'utf8')
    assert.ok(after.startsWith('<!-- dsh-ai-collab:global:generated'))
    assert.ok(after.endsWith(original))
    assert.equal(loadGlobal().modules.length, 2)

    setGlobalEnabled('g1', false)
    const rendered = renderGlobalFile()
    assert.equal(rendered.disabled, 1)
    assert.ok(!readFileSync(join(home, 'AGENTS.md'), 'utf8').includes('ask first'))

    setGlobalEnabled('g1', true)
    renderGlobalFile()
    assert.ok(readFileSync(join(home, 'AGENTS.md'), 'utf8').includes('ask first'))

    // force 重跑不得叠加 marker
    migrateGlobal({ force: true })
    const forced = readFileSync(join(home, 'AGENTS.md'), 'utf8')
    assert.equal((forced.match(/dsh-ai-collab:global:generated/g) || []).length, 1)
    assert.equal(loadGlobal().modules.length, 2)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('项目纪律启用才内联，停用只列表；audit 能发现漂移', () => {
  const root = temp('proj')
  mkdirSync(join(root, '.ai', 'disciplines', 'rules'), { recursive: true })
  writeFileSync(join(root, '.ai', 'disciplines', 'disciplines.json'), JSON.stringify({
    version: 1,
    rules: [
      { id: 'on-rule', title: '启用规则', file: 'on-rule.md', enabled: true },
      { id: 'off-rule', title: '停用规则', file: 'off-rule.md', enabled: false },
    ],
  }), 'utf8')
  writeFileSync(join(root, '.ai', 'disciplines', 'rules', 'on-rule.md'), '## 启用规则\n\n必须这样做。\n', 'utf8')
  writeFileSync(join(root, '.ai', 'disciplines', 'rules', 'off-rule.md'), '## 停用规则\n\n不要执行。\n', 'utf8')

  const section = renderProjectSection(root)
  assert.ok(section.table.includes('P-on-rule'))
  assert.ok(section.table.includes('P-off-rule'))
  assert.ok(section.rules.includes('必须这样做'))
  assert.ok(!section.rules.includes('不要执行'))
  assert.ok(!section.rules.includes('## 启用规则'))

  const clean = `${section.table}\n${section.rules}`
  assert.deepEqual(auditProject(root, clean), [])

  const missingEnabled = `${section.table}\n`
  const drift1 = auditProject(root, missingEnabled)
  assert.ok(drift1.some((e) => e.includes('on-rule')), drift1.join('; '))

  const disabledInline = `${clean}\n<!-- dsh-ai-collab:discipline:off-rule:start -->\n不要执行。\n<!-- dsh-ai-collab:discipline:off-rule:end -->\n`
  const drift2 = auditProject(root, disabledInline)
  assert.ok(drift2.some((e) => e.includes('off-rule')), drift2.join('; '))
})

test('writeSessionBoot 生成接棒提示词并带最近记录', () => {
  const root = temp('boot')
  mkdirSync(join(root, '.ai'), { recursive: true })
  writeFileSync(join(root, '.ai', 'status.json'), JSON.stringify({ project: 'demo', phase: 'dev' }), 'utf8')
  const rec = { id: '20260101T000000000-abcdef', ts: '2026-01-01T00:00:00+08:00', tool: 'test', status: 'ok', action: 'fix', summary: '修好了' }
  writeFileSync(join(root, '.ai', 'log.jsonl'), JSON.stringify(rec) + '\n', 'utf8')

  writeSessionBoot(root, { maxTail: 5 })
  const text = readFileSync(join(root, '.ai', 'SESSION_BOOT.md'), 'utf8')
  assert.match(text, /接棒提示词/)
  assert.match(text, /修好了/)
  assert.match(text, /继承摘要/)
  assert.equal(buildHandoff(root, { maxTail: 5 }).recent.length, 1)
})
