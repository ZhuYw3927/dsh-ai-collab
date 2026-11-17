// 回归测试：AGENTS.md 的保护与“重渲染不得改动事实/日志”
// 仅在 Windows 上运行（依赖 PowerShell）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const ENSURE = join(PKG, 'ai-ensure.ps1')
const winOnly = { skip: process.platform !== 'win32' }

// 用非临时目录（ai-ensure 会拒绝 %TEMP%）；放在用户主目录下的隐藏临时目录
function makeWorkspace(prefix = '.aipres-') {
  const dir = mkdtempSync(join(process.env.USERPROFILE || process.env.HOME, prefix))
  mkdirSync(join(dir, '.git'))
  return dir
}

function runEnsure(root) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENSURE, '-Root', root], { encoding: 'utf8' })
  assert.equal(r.status, 0, `ensure 失败: ${r.stderr || r.stdout}`)
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

test('手写 AGENTS.md 不被覆盖，并保留参考渲染', winOnly, () => {
  const dir = makeWorkspace()
  const handWritten = '# 我上一轮手写的规则\n\n- 不得覆盖我\n'
  writeFileSync(join(dir, 'AGENTS.md'), handWritten, 'utf8')
  try {
    const res = runEnsure(dir)
    assert.equal(res.adopted, true)
    assert.equal(res.agentsPreserved, true)
    assert.equal(readText(join(dir, 'AGENTS.md')), handWritten)
    assert.ok(existsSync(join(dir, '.ai', 'AGENTS.generated.md')))
    assert.match(readText(join(dir, '.ai', 'AGENTS.generated.md')), /dsh-ai-collab:generated/)
    // 接入时日志必须是空文件，不能凭空产生记录
    assert.equal(readText(join(dir, '.ai', 'log.jsonl')).trim(), '')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('框架生成的 AGENTS.md 可重渲染，但事实与日志不变', winOnly, () => {
  const dir = makeWorkspace()
  try {
    // 1) 正常接入（生成带标记的 AGENTS.md）
    const first = runEnsure(dir)
    assert.equal(first.adopted, true)
    const agentsPath = join(dir, 'AGENTS.md')
    assert.match(readText(agentsPath), /dsh-ai-collab:generated/)

    // 2) 写一条工作日志（走官方入口）
    const add = spawnSync('cmd.exe', ['/c', join(dir, '.ai', 'llm.cmd'), 'add', '-Tool', 'human', '-Action', 'doc',
      '-Status', 'ok', '-Summary', 'preservation-test'], { encoding: 'utf8' })
    assert.equal(add.status, 0, `add 失败: ${add.stderr || add.stdout}`)

    const logPath = join(dir, '.ai', 'log.jsonl')
    const phPath = join(dir, '.ai', 'placeholders.json')
    const logBefore = readText(logPath)
    const phBefore = readText(phPath)
    assert.equal(logBefore.trim().split('\n').length, 1)
    const agentsBefore = readText(agentsPath)
    const mtimeBefore = statSync(agentsPath).mtimeMs

    // 3) 模拟框架升级：让 framework-hash 失效，触发重渲染
    writeFileSync(join(dir, '.ai', 'framework-hash'), 'stale', 'utf8')
    const res = runEnsure(dir)
    assert.equal(res.filesUpdated, true)

    // 4) 日志与事实（placeholders）必须逐字节不变
    assert.equal(readText(logPath), logBefore, '工作日志被改动')
    assert.equal(readText(phPath), phBefore, '项目事实 placeholders 被改动')

    // 5) AGENTS.md 仍是生成文件，内容与事实一致（模板未变时内容不变）
    const agentsAfter = readText(agentsPath)
    assert.match(agentsAfter, /dsh-ai-collab:generated/)
    assert.equal(agentsAfter, agentsBefore)
    assert.ok(statSync(agentsPath).mtimeMs >= mtimeBefore)

    // 6) status.json 不被重渲染改动（只由 add/status 维护）
    assert.ok(existsSync(join(dir, '.ai', 'status.json')))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('手写 AGENTS.md 在框架升级后仍保留', winOnly, () => {
  const dir = makeWorkspace()
  const handWritten = '# HAND\n- keep\n'
  writeFileSync(join(dir, 'AGENTS.md'), handWritten, 'utf8')
  try {
    runEnsure(dir)
    writeFileSync(join(dir, '.ai', 'framework-hash'), 'stale', 'utf8')
    const res = runEnsure(dir)
    assert.equal(res.agentsPreserved, true)
    assert.equal(readText(join(dir, 'AGENTS.md')), handWritten)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目自维护区在重渲染后逐字保留', winOnly, () => {
  const dir = makeWorkspace()
  try {
    runEnsure(dir)
    const agentsPath = join(dir, 'AGENTS.md')
    const before = readText(agentsPath)
    // 在 user 区追加项目专有内容（采样数据 / 分析方法）
    const marker = '<!-- dsh-ai-collab:user:end -->'
    assert.ok(before.includes(marker))
    const custom = '## 项目专有\n\n- 采样数据：200 Hz 原始输出\n- 分析方法：Allan 偏差\n'
    const edited = before.replace(marker, custom + marker)
    writeFileSync(agentsPath, edited, 'utf8')

    const phPath = join(dir, '.ai', 'placeholders.json')
    const phBefore = readText(phPath)
    const logPath = join(dir, '.ai', 'log.jsonl')
    const logBefore = readText(logPath)

    // 触发重渲染
    writeFileSync(join(dir, '.ai', 'framework-hash'), 'stale', 'utf8')
    runEnsure(dir)

    const after = readText(agentsPath)
    assert.ok(after.includes(custom), '项目自维护内容丢失')
    assert.ok(after.includes('dsh-ai-collab:generated:start'))
    assert.equal(readText(phPath), phBefore)
    assert.equal(readText(logPath), logBefore)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧格式单行标记文件被冻结，不再自动覆盖', winOnly, () => {
  const dir = makeWorkspace()
  const legacy = '<!-- dsh-ai-collab:generated; old -->\n# 旧格式 AGENTS\n\n- 保留我\n'
  writeFileSync(join(dir, 'AGENTS.md'), legacy, 'utf8')
  try {
    const res = runEnsure(dir)
    assert.equal(res.agentsPreserved, true)
    assert.equal(readText(join(dir, 'AGENTS.md')), legacy)
    assert.ok(existsSync(join(dir, '.ai', 'AGENTS.generated.md')))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
