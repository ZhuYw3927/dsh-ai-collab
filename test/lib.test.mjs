// Pure-JS tests: config normalisation and TASKS.md rendering.
// These run on every platform and never spawn PowerShell.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { parseRecords, renderTasks, writeTasks } from '../lib/tasks.js'

test('normalizeConfig: defaults', () => {
  const c = normalizeConfig(undefined)
  assert.equal(c.autoInit, false)
  assert.equal(c.maxTail, 10)
  assert.equal(c.initScript, '')
  assert.deepEqual(c.warnings, [])
})

test('normalizeConfig: boolean coercion and warnings', () => {
  assert.equal(normalizeConfig({ autoInit: 'true' }).autoInit, true)
  assert.equal(normalizeConfig({ autoInit: '0' }).autoInit, false)
  assert.equal(normalizeConfig({ autoInit: true }).autoInit, true)
  const bad = normalizeConfig({ autoInit: 'maybe' })
  assert.equal(bad.autoInit, false)
  assert.equal(bad.warnings.length, 1)
})

test('normalizeConfig: maxTail bounds and initScript', () => {
  assert.equal(normalizeConfig({ maxTail: 25 }).maxTail, 25)
  assert.equal(normalizeConfig({ maxTail: 0 }).maxTail, 10)
  assert.equal(normalizeConfig({ maxTail: 1e6 }).maxTail, 10)
  assert.equal(normalizeConfig({ maxTail: '7' }).maxTail, 7)
  assert.equal(normalizeConfig({ initScript: '  C:\\x.ps1 ' }).initScript, 'C:\\x.ps1')
  assert.equal(normalizeConfig({ initScript: 42 }).initScript, '')
})

test('renderTasks: header, reverse order, escaping', () => {
  const records = [
    { ts: '2026-11-17T10:00:00+08:00', action: 'fix', status: 'ok', summary: 'a|b', id: 'id-1' },
    { ts: '2026-11-17T11:00:00+08:00', action: 'doc', status: 'partial', summary: 'second', id: 'id-2' },
  ]
  const text = renderTasks(records, '2026-11-17T12:00:00+08:00')
  assert.ok(text.startsWith('# 任务记录清单\n\n'))
  assert.ok(text.includes('共 2 条；按时间倒序。最后更新 2026-11-17T12:00:00+08:00'))
  assert.ok(text.includes('| 2026-11-17T11:00:00+08:00 | doc | partial | second | `id-2` |'))
  assert.ok(text.includes('| 2026-11-17T10:00:00+08:00 | fix | ok | a\\|b | `id-1` |'))
  // newest first: id-2 appears before id-1
  assert.ok(text.indexOf('id-2') < text.indexOf('id-1'))
  assert.ok(text.endsWith('\n'))
})

test('renderTasks: empty list placeholder', () => {
  const text = renderTasks([], 'now')
  assert.ok(text.includes('共 0 条'))
  assert.ok(text.includes('| （暂无记录） | | | | |'))
})

test('parseRecords: skips blank and malformed lines', () => {
  const records = parseRecords('{"id":"a"}\n\nnot json\n{"id":"b"}\n')
  assert.deepEqual(records.map((r) => r.id), ['a', 'b'])
})

test('writeTasks: writes TASKS.md from .ai/log.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-'))
  try {
    mkdirSync(join(dir, '.ai'))
    writeFileSync(join(dir, '.ai', 'log.jsonl'), '{"ts":"t1","action":"fix","status":"ok","summary":"s","id":"i1"}\n', 'utf8')
    const result = writeTasks(dir, 'now')
    assert.equal(result.written, true)
    assert.equal(result.count, 1)
    const text = readFileSync(join(dir, 'TASKS.md'), 'utf8')
    assert.ok(text.includes('| t1 | fix | ok | s | `i1` |'))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeTasks: no log means no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-'))
  try {
    const result = writeTasks(dir, 'now')
    assert.equal(result.written, false)
    assert.equal(existsSync(join(dir, 'TASKS.md')), false)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
