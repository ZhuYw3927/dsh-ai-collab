/**
 * Cross-process file lock.
 *
 * The plugin can be loaded by several sessions of the same DSH profile, and the
 * framework also runs PowerShell writers (`.ai\llm.ps1`, `install.ps1`). They
 * all cooperate through a lock file created with O_EXCL (`wx`): whoever creates
 * it owns the critical section, everyone else waits. A crashed owner leaves the
 * file behind, so a second creator may break the lock after `staleMs`.
 *
 * Lock files are deliberately separate per resource (log, tasks, agents,
 * ensure) so a writer never waits on a lock it already holds.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { sleepSync } from './atomic.js'

function tryCreate(path) {
  const fd = openSync(path, 'wx')
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }))
  } finally {
    closeSync(fd)
  }
}

function isStale(path, staleMs) {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs
  } catch {
    return false
  }
}

/**
 * Run `fn` while holding `lockPath`.
 * Throws when the lock cannot be acquired within `timeoutMs`; `fn` errors
 * propagate after the lock is released.
 */
export function withLock(lockPath, fn, { timeoutMs = 15000, staleMs = 30000, retryMs = 40 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      tryCreate(lockPath)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (isStale(lockPath, staleMs)) {
        try { unlinkSync(lockPath) } catch { /* someone else broke it first */ }
        continue
      }
      if (Date.now() > deadline) throw new Error(`获取锁超时(${timeoutMs}ms): ${lockPath}`)
      sleepSync(retryMs)
    }
  }
  try {
    return fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* already gone */ }
  }
}

/** Non-blocking probe used by read-only callers that should not wait. */
export function lockHeld(lockPath, staleMs = 30000) {
  try {
    return !isStale(lockPath, staleMs)
  } catch {
    return false
  }
}
