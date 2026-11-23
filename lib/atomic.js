/**
 * Atomic file writes and timestamped backups.
 *
 * Why: the plugin updates `status.json`, `TASKS.md`, `AGENTS.md` and the global
 * discipline file while other sessions/tools may read them. A plain
 * `writeFileSync` truncates first, so a reader can observe a half-written file;
 * a crash mid-write loses the previous content. Write to a sibling temp file,
 * fsync it, then rename over the target: readers see either the old or the new
 * file, never a partial one.
 */
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Synchronous sleep that does not need timers (works inside a lock loop). */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Replace `path` atomically with `data`.
 * Rename is retried a few times because Windows antivirus/indexers can hold a
 * short-lived handle on the target (`EPERM`/`EBUSY`).
 */
export function writeFileAtomic(path, data, { encoding = 'utf8', retries = 6 } = {}) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  let fd
  try {
    fd = openSync(tmp, 'w')
    writeFileSync(fd, data, typeof data === 'string' ? encoding : undefined)
    try { fsyncSync(fd) } catch { /* fsync is best effort */ }
    closeSync(fd)
    fd = undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, path)
        return path
      } catch (error) {
        if (attempt >= retries || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        sleepSync(40 * (attempt + 1))
      }
    }
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd) } catch { /* already closed */ }
    try { rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    throw error
  }
}

/** Timestamp safe for filenames: 20261123-152000-123. */
export function fileStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`
}

/**
 * Copy `path` into `backupDir` with a timestamp, then prune oldest copies.
 * Returns the backup path, or null when the source does not exist.
 */
export function backupFile(path, backupDir, { prefix = '', keep = 10 } = {}) {
  if (!existsSync(path)) return null
  mkdirSync(backupDir, { recursive: true })
  const backup = join(backupDir, `${prefix || basename(path)}.${fileStamp()}.bak`)
  copyFileSync(path, backup)
  try {
    const entries = readdirSync(backupDir)
      .filter((name) => name.startsWith(`${prefix || basename(path)}.`) && name.endsWith('.bak'))
      .map((name) => ({ name, time: statSync(join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const stale of entries.slice(keep)) rmSync(join(backupDir, stale.name), { force: true })
  } catch { /* pruning is best effort */ }
  return backup
}

/** Read a UTF-8 file, returning '' when missing. */
export function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}
