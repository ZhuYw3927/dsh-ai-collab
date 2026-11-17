import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __internals } from '../index.js'

const { appendRecord, recordErrors, readLines, nowIso, newId } = __internals

test('nowIso 带时区偏移', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
})

test('newId 唯一且足够长', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId()))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.ok(id.length >= 8)
})

test('appendRecord 写入一行合法 JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-collab-'))
  try {
    const rec = appendRecord(dir, { summary: '测试记录', status: 'ok', action: 'doc' })
    const lines = readLines(join(dir, '.ai', 'log.jsonl'))
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.id, rec.id)
    assert.equal(parsed.summary, '测试记录')
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.tool, 'deepseek-harness')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('blocked 缺少 issue 时拒绝写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-collab-'))
  try {
    assert.throws(() => appendRecord(dir, { summary: '阻塞但没原因', status: 'blocked' }), /issue/)
    assert.equal(existsSync(join(dir, '.ai', 'log.jsonl')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendRecord 同步刷新 status.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-collab-'))
  try {
    mkdirSync(join(dir, '.ai'), { recursive: true })
    writeFileSync(join(dir, '.ai', 'status.json'), JSON.stringify({ project: 'T', blockers: [] }), 'utf8')
    appendRecord(dir, { summary: '阻塞记录', status: 'blocked', issue: '硬件未到' })
    const st = JSON.parse(readFileSync(join(dir, '.ai', 'status.json'), 'utf8'))
    assert.deepEqual(st.blockers, ['硬件未到'])
    assert.ok(st.last_log_ts)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordErrors 能识别非法枚举与时区缺失', () => {
  const bad = recordErrors({ id: 'x'.repeat(8), ts: '2026-01-01T00:00:00', tool: 't', summary: 's', status: 'weird' }, 3)
  assert.ok(bad.some((e) => e.includes('status 非法')))
  assert.ok(bad.some((e) => e.includes('ts')))
  assert.ok(bad.every((e) => e.startsWith('第 3 行')))
})
