# Market release checklist

Published as `dsh-ai-collab@0.7.0`. The remaining steps take it to the
community plugin market (`dshmarket` / awesome-dsh-plugin) and, optionally, a self-hosted
format-1 index.

## Release log

| Version | npm | Git tag | Market entry PR |
|---|---|---|---|
| `0.7.0` (2026-11-27) | published | `v0.7.0` | docs/desc-070 — description refresh for clean root layout / auto-rendered HTML views / resumed-session sync (pending) |
| `0.5.0` (2026-11-23) | published | `v0.5.0` | #18120 — description refresh for disciplines / handoff / safe writes (open) |
| `0.4.4` (2026-11-20) | published | `v0.4.4` | #17234 — intro-page link in description (merged) |
| `0.4.3` (2026-11-17) | published | `v0.4.3` | #16419 — first listing (merged) |

## 0. Preconditions (already satisfied)

| Item | Status |
|---|---|
| `dsh.bundle.patch` declared | yes (`./cordis.patch.yml`) |
| No build scripts, no native modules | yes (nothing to compile on install) |
| Package manifest complete | `engines.dsh`, `os`, `exports` (locale/icon), `files` whitelist |
| Display metadata | `locale/en.json`, `locale/zh.json`, `icon.svg`, `docs/DETAIL.md` |
| Tests | `npm test` (41 cases) |
| npm name `dsh-ai-collab` | taken by this package |
| Local-only data | none: paths, hostnames and project names in examples are placeholders |

Still missing (needs the maintainer's accounts):

- npm login (`npm login --registry https://registry.npmjs.org`);
- the awesome-dsh-plugin PR (after the npm release);
- pushing the repository for the first time (see §1b).

## 1. Publish to npm

```powershell
cd <package-dir>
npm run check
npm test
npm pack --dry-run            # inspect the file list (39 files)
npm publish --access public --registry https://registry.npmjs.org
npm view dsh-ai-collab version
```

### 1b. First push to GitHub

The repository is `https://github.com/ZhuYw3927/dsh-ai-collab` (public). On a fresh clone or
after `git init`:

```powershell
git remote add origin https://github.com/ZhuYw3927/dsh-ai-collab.git   # once
git push -u origin main
```

After publishing, add the repository fields and publish a patch release if they changed.

## 2. Submit to the community market

The market app `dshmarket` reads its catalog from the curated
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry.
**Open a PR against that repository**, not against the market app.

The PR adds one entry to the list (follow the registry's template) with:

- package name: `dsh-ai-collab`
- repository URL
- one-line description (English; the site is bilingual)
- install command: `dsh plugin --profile <profile> add dsh-ai-collab`
- platform note: **Windows only for now**

After the PR merges, `awesome-dsh-plugin.com/plugins.json` and the market UI pick it up,
usually within a day.

## 3. Optional: self-hosted format-1 index

`dsh-plugin-market` (official Discover) reads indexes a user adds under
**Plugins → Discover → Index sources**. Generate one from the published package:

```powershell
$env:REPO_URL = 'https://github.com/<owner>/dsh-ai-collab'
node scripts/make-market-index.mjs        # writes market/index.json
```

Host the resulting JSON over HTTPS and add its URL to Discover. The generator refuses to run
without a valid `REPO_URL`, because the index validator requires canonical https URLs.

## 4. Post-publish verification

```powershell
dsh --profile aicollab-test --from-default-profile web --dump-config
dsh plugin --profile aicollab-test add dsh-ai-collab
dsh --profile aicollab-test --dump-config | Select-String ai-collab
```

Then, in a session of that profile: call `ai_status` (should report the workspace and an empty
`.ai/`), and `ai_init` on a scratch project (should scaffold `AGENTS.md` + `.ai/`).

## 5. Rollback

| Situation | Action |
|---|---|
| Bad npm version | publish a fixed patch; `npm deprecate` the broken one |
| Plugin breaks host boot | remove `dsh-ai-collab` from `dsh.profile.bundles` and restart |
| Want to disable only | set `disabled: true` on its row in the profile patch and restart |
