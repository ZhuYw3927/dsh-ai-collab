/**
 * Config normalisation for dsh-ai-collab.
 *
 * The bundle does not export a schemastery `Config` yet (that would add a
 * runtime dependency the plugin cannot resolve from outside `app.asar`), so
 * values arriving from the profile patch are normalised here instead of being
 * used raw. Every rejected value is reported as a warning, never silently kept.
 */

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off'])

function normaliseBoolean(value, fallback, key, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(text)) return true
  if (FALSE_WORDS.has(text)) return false
  warnings.push(`${key}: expected a boolean, got ${JSON.stringify(value)}; using ${fallback}`)
  return fallback
}

function normaliseMaxTail(value, warnings) {
  if (value === undefined || value === null) return 10
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    warnings.push(`maxTail: expected an integer in 1..200, got ${JSON.stringify(value)}; using 10`)
    return 10
  }
  return n
}

function normaliseInitScript(value, warnings) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    warnings.push(`initScript: expected a string path, got ${JSON.stringify(value)}; ignoring`)
    return ''
  }
  return value.trim()
}

/** @returns {{autoInit: boolean, maxTail: number, initScript: string, warnings: string[]}} */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const autoInit = normaliseBoolean(config.autoInit, false, 'autoInit', warnings)
  const maxTail = normaliseMaxTail(config.maxTail, warnings)
  const initScript = normaliseInitScript(config.initScript, warnings)
  return { autoInit, maxTail, initScript, warnings }
}
