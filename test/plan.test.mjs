import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyPlan, readPlan, writePlan, setBlock, doneChecklistItem,
  activeRiskTitles, renderPlanMarkdown, renderTasksMarkdown,
  renderTasksHtml, writeAllRenders,
} from '../lib/plan.js'
import { scanProjects, renderDashboard, writeDashboard } from '../lib/dashboard.js'

const temp = (prefix) => mkdtempSync(join(tmpdir(), `dsh-plan-${prefix}-`))

// ---------------------------------------------------------------- plan.js

test('emptyPlan returns valid schema', () => {
  const p = emptyPlan()
  assert.equal(p.schema_version, 1)
  assert.deepEqual(p.plan, [])
  assert.deepEqual(p.checklist, [])
  assert.deepEqual(p.risks, [])
})

test('readPlan returns emptyPlan when file missing', () => {
  const dir = temp('missing')
  const plan = readPlan(dir)
  assert.deepEqual(plan.plan, [])
})

test('writePlan + readPlan round-trip', () => {
  const dir = temp('rw')
  mkdirSync(join(dir, '.ai'), { recursive: true })
  const p = emptyPlan()
  p.plan.push({ id: 'p1', step: 'test', acceptance: 'pass', status: 'todo', owner: 'human', due: '2026-12-01' })
  const result = writePlan(dir, p, '2026-11-27T12:00:00+08:00')
  assert.equal(result.plan.length, 1)
  const loaded = readPlan(dir)
  assert.equal(loaded.plan[0].id, 'p1')
  assert.equal(loaded.updated_at, '2026-11-27T12:00:00+08:00')
})

test('setBlock replaces one block', () => {
  const dir = temp('setblock')
  mkdirSync(join(dir, '.ai'), { recursive: true })
  writePlan(dir, emptyPlan(), 'now')
  setBlock(dir, 'checklist', [
    { id: 'c1', item: 'verify build', status: 'open', link: '' },
    { id: 'c2', item: 'run tests', status: 'open', link: '' },
  ], 'now')
  const loaded = readPlan(dir)
  assert.equal(loaded.checklist.length, 2)
  assert.equal(loaded.checklist[0].id, 'c1')
  // setBlock should not wipe other blocks
  loaded.plan.push({ id: 'p1', step: 's', acceptance: 'a', status: 'todo', owner: 'h', due: '' })
  writePlan(dir, loaded, 'now')
  setBlock(dir, 'checklist', [{ id: 'c3', item: 'only one left', status: 'open', link: '' }], 'now')
  const reloaded = readPlan(dir)
  assert.equal(reloaded.checklist.length, 1)
  assert.equal(reloaded.checklist[0].id, 'c3')
  assert.equal(reloaded.plan.length, 1) // plan block preserved
})

test('doneChecklistItem marks item done', () => {
  const dir = temp('done')
  mkdirSync(join(dir, '.ai'), { recursive: true })
  const p = emptyPlan()
  p.checklist.push({ id: 'c1', item: 'step A', status: 'open', link: '' })
  p.checklist.push({ id: 'c2', item: 'step B', status: 'open', link: '' })
  writePlan(dir, p, 'now')
  const { item } = doneChecklistItem(dir, 'c1', 'now')
  assert.equal(item.status, 'done')
  const loaded = readPlan(dir)
  assert.equal(loaded.checklist[0].status, 'done')
  assert.equal(loaded.checklist[1].status, 'open')
})

test('doneChecklistItem throws for missing id', () => {
  const dir = temp('donemiss')
  mkdirSync(join(dir, '.ai'), { recursive: true })
  writePlan(dir, emptyPlan(), 'now')
  assert.throws(() => doneChecklistItem(dir, 'nope', 'now'), /不存在/)
})

test('activeRiskTitles filters active risks', () => {
  const p = emptyPlan()
  p.risks.push({ id: 'r1', risk: '硬件离线', probability: '高', impact: '高', strategy: '规避', status: 'active' })
  p.risks.push({ id: 'r2', risk: '温漂超标', probability: '中', impact: '中', strategy: '接受', status: 'resolved' })
  p.risks.push({ id: 'r3', risk: '内存不足', probability: '低', impact: '高', strategy: '减轻', status: 'active' })
  const titles = activeRiskTitles(p)
  assert.deepEqual(titles, ['硬件离线', '内存不足'])
})

test('renderPlanMarkdown includes all sections', () => {
  const p = emptyPlan()
  p.plan.push({ id: 'p1', step: 'init', acceptance: 'done', status: 'in_progress', owner: 'ai', due: '2026-12-01' })
  p.checklist.push({ id: 'c1', item: 'check', status: 'open', link: 'log-1' })
  p.risks.push({ id: 'r1', risk: 'risk X', probability: '高', impact: '高', strategy: '规避', status: 'active' })
  p.updated_at = 'now'
  const md = renderPlanMarkdown(p)
  assert.ok(md.includes('## 执行计划'))
  assert.ok(md.includes('| p1 | init | done | 进行中 | ai | 2026-12-01 |'))
  assert.ok(md.includes('## 检查清单'))
  assert.ok(md.includes('| c1 | check | 待办 | log-1 |'))
  assert.ok(md.includes('## 风险与应对'))
  assert.ok(md.includes('| risk X | 高 | 高 | 规避 | 活跃 |'))
})

test('renderTasksMarkdown three-section vs log-only', () => {
  const records = [
    { ts: '2026-11-27T10:00:00+08:00', action: 'fix', status: 'ok', summary: 'done', id: 'id-1' },
  ]
  // With plan
  const p = emptyPlan()
  p.plan.push({ id: 'p1', step: 'do', acceptance: 'pass', status: 'todo', owner: 'h', due: '' })
  const md = renderTasksMarkdown('root', records, p, 'now')
  assert.ok(md.includes('## 执行计划'))
  assert.ok(md.includes('## 工作日志'))
  // Without plan (empty)
  const md2 = renderTasksMarkdown('root', records, emptyPlan(), 'now')
  assert.ok(!md2.includes('## 执行计划'))
  assert.ok(md2.includes('## 工作日志'))
})

test('renderTasksHtml generates self-contained HTML', () => {
  const records = [
    { ts: '2026-11-27T10:00:00+08:00', action: 'fix', status: 'ok', summary: 'done', id: 'id-1' },
  ]
  const p = emptyPlan()
  p.checklist.push({ id: 'c1', item: 'verify', status: 'open', link: '' })
  const html = renderTasksHtml('/root', records, p, 'now', 'TestProject')
  assert.ok(html.includes('<!DOCTYPE html>'))
  assert.ok(html.includes('<title>TestProject'))
  assert.ok(html.includes('✅ 检查清单'))
  assert.ok(html.includes('id-1'))
  // No plan section when no plan
  assert.ok(!html.includes('📋 执行计划'))
})

test('writeAllRenders creates TASKS.md + TASKS.html + PLAN.md', () => {
  const dir = temp('allrender')
  mkdirSync(join(dir, '.ai'), { recursive: true })
  writeFileSync(join(dir, '.ai', 'log.jsonl'), '{"id":"a","ts":"2026-11-27T10:00:00+08:00","tool":"t","actor":"ai","status":"ok","summary":"test"}\n', 'utf8')
  const p = emptyPlan()
  p.plan.push({ id: 'p1', step: 's', acceptance: 'a', status: 'todo', owner: 'h', due: '' })
  writePlan(dir, p, 'now')
  const result = writeAllRenders(dir, [{ id: 'a', ts: '2026-11-27T10:00:00+08:00', tool: 't', actor: 'ai', status: 'ok', summary: 'test' }], 'now', 'Proj')
  assert.ok(existsSync(join(dir, 'TASKS.md')))
  assert.ok(existsSync(join(dir, 'TASKS.html')))
  assert.ok(existsSync(join(dir, '.ai', 'PLAN.md')))
  const md = readFileSync(join(dir, 'TASKS.md'), 'utf8')
  assert.ok(md.includes('## 执行计划'))
  assert.ok(md.includes('## 工作日志'))
  const html = readFileSync(join(dir, 'TASKS.html'), 'utf8')
  assert.ok(html.includes('Proj'))
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- dashboard.js

test('scanProjects reads sibling project status', () => {
  const dir = temp('scan')
  mkdirSync(join(dir, 'projA', '.ai'), { recursive: true })
  mkdirSync(join(dir, 'projB', '.ai'), { recursive: true })
  mkdirSync(join(dir, '_skip', '.ai'), { recursive: true })
  writeFileSync(join(dir, 'projA', '.ai', 'status.json'), JSON.stringify({ project: 'A', phase: 'build', focus: 'f1', blockers: [], next: [], updated_at: '2026-11-27T10:00:00+08:00' }), 'utf8')
  writeFileSync(join(dir, 'projA', '.ai', 'log.jsonl'), '{"id":"a"}\n{"id":"b"}\n', 'utf8')
  writeFileSync(join(dir, 'projB', '.ai', 'status.json'), JSON.stringify({ project: 'B', phase: 'init', focus: 'f2', blockers: ['blocked!'], next: ['n1'], updated_at: '2026-11-26T10:00:00+08:00' }), 'utf8')
  const rows = scanProjects(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].project, 'A') // more recent first
  assert.equal(rows[0].logCount, 2)
  assert.equal(rows[1].blockers[0], 'blocked!')
  rmSync(dir, { recursive: true, force: true })
})

test('renderDashboard generates self-contained HTML with blockers', () => {
  const rows = [
    { project: 'ProjA', dir: 'projA', phase: 'build', focus: 'f1', blockers: ['离线'], next: ['n1'], updated_at: '2026-11-27T10:00:00+08:00', logCount: 20 },
    { project: 'ProjB', dir: 'projB', phase: 'init', focus: 'f2', blockers: [], next: [], updated_at: '2026-11-26T10:00:00+08:00', logCount: 5 },
  ]
  const html = renderDashboard(rows, '/parent', 'now')
  assert.ok(html.includes('<!DOCTYPE html>'))
  assert.ok(html.includes('跨项目仪表盘'))
  assert.ok(html.includes('🚨 当前阻塞'))
  assert.ok(html.includes('ProjA'))
  assert.ok(html.includes('离线'))
  assert.ok(html.includes('共 2 个项目'))
  assert.ok(html.includes('bar-fill')) // trend bars
})

test('writeDashboard skips when no board.md in parent', () => {
  const dir = temp('nodash')
  mkdirSync(dir, { recursive: true })
  const result = writeDashboard(join(dir, 'dummy'))
  assert.equal(result, null)
  rmSync(dir, { recursive: true, force: true })
})