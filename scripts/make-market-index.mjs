// Generate a format-1 plugin market index for this package.
//
// Usage:
//   $env:REPO_URL = 'https://github.com/<owner>/dsh-ai-collab'
//   node scripts/make-market-index.mjs           # writes market/index.json
//
// The index validator requires canonical https URLs and a publish timestamp in Unix seconds,
// so the generator refuses to run without a real repository URL.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const repo = process.env.REPO_URL || ''

let url
try {
  url = new URL(repo)
} catch {
  console.error('REPO_URL must be an absolute https URL, e.g. https://github.com/owner/dsh-ai-collab')
  process.exit(2)
}
if (url.protocol !== 'https:' || url.pathname.split('/').filter(Boolean).length < 2) {
  console.error('REPO_URL must be https and name a repository with at least two path segments')
  process.exit(2)
}
const homepage = url.href.replace(/\/$/, '')

const localized = (en, zh) => ({ en, zh })
const index = {
  format: 1,
  title: localized('dsh-ai-collab', 'AI 协作层'),
  description: localized(
    'Project memory for every AI tool: an append-only .ai/ work log and a zoned AGENTS.md.',
    '给所有 AI 工具共用一份项目记忆：只追加的 .ai/ 工作日志，以及分区 AGENTS.md。',
  ),
  metadata: {
    categories: { productivity: { title: localized('Productivity', '效率') } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: localized('AI collaboration layer', 'AI 协作层'),
      description: localized(
        'Shared project memory for DSH, Claude Code, Cursor and other AI tools.',
        '面向 DSH、Claude Code、Cursor 等工具的共享项目记忆层。',
      ),
      author: pkg.author,
      homepage,
      repository: { url: homepage },
      metadata: {
        category: 'productivity',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'npm' },
          engines: { dsh: pkg.engines?.dsh ?? '>=0.2.1' },
        },
      ],
    },
  ],
}

const out = resolve(root, 'market', 'index.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out} (${pkg.name}@${pkg.version})`)
