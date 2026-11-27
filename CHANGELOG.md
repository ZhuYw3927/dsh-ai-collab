# Changelog

## 0.7.2 (2026-11-27)

- Renderer: `TASKS.html` is rebuilt on the dark, single-page design used by the visual
  introduction: hero (project · records · generated time), four counters (total / ok / partial /
  todo), a proportion bar, the plan / checklist / risks panels, and the work-log table with
  type and status tags, filter chips, `/` search, click-to-copy record ids and a scroll progress
  bar. Below 1040 px the table degrades to cards (`data-label` keeps every column name), so the
  same file is readable on a phone.
- Renderer: `dashboard.html` (cross-project) now shares that visual system: hero with
  projects / records / blocking counters, a current-blockers list, a per-project record trend and
  an overview table (state, phase, focus, blockers, records, last update) whose project and record
  cells link to that project's `TASKS.html`; also cards below 1040 px.
- Fix: placeholder blockers (`无` / `—` / `none`) are no longer counted as blockers nor listed in
  `Current blockers`.
- Migration: every already-adopted workspace was re-rendered once (`TASKS.html` × 10) and
  `dashboard.html` regenerated with the new templates.
- Tests: **41** (14 renderer tests, unchanged count).

## 0.7.1 (2026-11-27)

- Docs: the README now opens with a real screenshot of the visual introduction page. The plugin
  detail page renders the README itself: `meta.detail` was removed from `locale/en.json` and
  `locale/zh.json`, so the screenshot, feature notes and limitations stay in one document.
- Theme: the visual introduction page uses a single sans-serif stack for copy and headings;
  code blocks, counters and file names stay monospace.
- Docs: public material no longer contains local machine paths. Examples use `<workspace-parent>`
  and `$env:DSH_HOME` instead of a drive layout.
- Packaging: ships `docs/preview.png` (1600x1000) and `docs/preview.svg` (640x300, self-contained)
  for the store page and the visual introduction.
- Tests: 41 unchanged (docs and packaging release).

## 0.7.0 (2026-11-27)

- Feature: **clean project root**. `TASKS.md` moved to `.ai/TASKS.md`; the root keeps only
  `AGENTS.md` and the rendered HTML pages. Workspace docs/scripts/artifacts are sorted into
  `.ai/docs`, `.ai/scripts`, `.ai/dist` and `.ai/market`.
- Feature: **automatic HTML regeneration**. New `syncArtifacts(root)` in `index.js` re-renders
  `.ai/TASKS.md` + root `TASKS.html` + `.ai/PLAN.md` + `..\.ai\dashboard.html`; it is called from
  `ai_status`, `ai_log`, `ai_board`, `ai_plan` (`set`/`done`), `ai_init` and `session/created`
  autoInit, and from a global `session/event` hook (8 s throttle) that covers resumed sessions.
- Fix: visualization files were never produced unless an `ai_log`/`ai_plan` call happened after
  the upgrade.
  - `session/created` autoInit now renders the artifacts right after the workspace is synced.
  - `ai_board` now refreshes `dashboard.html` on every call (it still never writes `board.md`).
  - `ai_init` returns the artifacts flag and renders the same files.
- Fix: `dashboard.html` per-project links were resolved against `.ai\` instead of the parent
  directory (`../<project>/TASKS.html`) and were not URL-encoded (spaces broke the link).
- Docs: intro page (`docs/index.html`) refreshed for 0.7.0 (root layout policy, auto-sync,
  eight tools).
- Migration: `ai-ensure` / `ai_init` moves an existing root `TASKS.md` into `.ai/TASKS.md` and
  re-renders; verified on 10 workspaces (32/6/38/12/49/2/49/36/18/24 records).
- Tests: **41** (2 new artifact-sync tests in `test/smoke.test.mjs`; `npm run check` clean).
## 0.6.0

- Plan & task management: new `ai_plan` tool (show / set / done).
  - `.ai/plan.json` stores a structured plan: a goal block, a checklist block, and a risk block.
    Each risk has a severity (red/yellow/green), a mitigation, and an active/resolved flag.
  - `appendRecord` auto-merges active plan risks into `status.json` → `blockers`.
  - `lib/plan.js` renders three files atomically: `PLAN.md` (the plan itself), `TASKS.md` (three
    sections: current plan → checklist → risk log, followed by the reverse-chronological log),
    and `TASKS.html` (self-contained dashboard-style HTML, same visual language as
    `dashboard.html`).
  - `refreshTasks` no longer requires a manual `.ai/tasks-enabled` marker — the file is created
    automatically on first write.
- Cross-project dashboard: `lib/dashboard.js` generates `<workspace-parent>\.ai\dashboard.html` from
  all sibling project statuses. Rows with active blockers are highlighted in red; each project
  gets a sparkline bar of record counts from the last 7 log entries. Run automatically after
  every `ai_log` and `ai_init`.
- Workspace cleanup: root directory reduced to `AGENTS.md` + `TASKS.md` + `dsh-ai-collab.html`;
  everything else moved into `.ai/docs/`, `.ai/scripts/`, `.ai/dist/`, `.ai/market/`.
  Stray `dsh-ai-collab-0.4.3.zip` deleted.
- Tests: 39 (14 new for plan I/O, checklist toggling, risk merging, Markdown/HTML rendering,
  project scanning and dashboard generation; all old tests pass).
- Documentation: `AGENTS.template.md` §6 table now lists `plan.json`/`PLAN.md`, the three
  sub-directories, `dashboard.html` and `TASKS.html`.

## 0.5.0

- Disciplines: global modules + project rules.
  - New `ai_discipline` tool: `list/add/enable/disable/remove` for
    `.ai/disciplines/disciplines.json` + `.ai/disciplines/rules/<id>.md`;
    `global-list/global-migrate/global-add/global-enable/global-disable/global-remove`
    for `$DSH_HOME/disciplines/`.
  - `global-migrate` splits an existing `$DSH_HOME/AGENTS.md` into `g0.md … gN.md` + a registry,
    then rewrites `AGENTS.md` as a marker line plus the original text (byte-for-byte, backup
    first). Toggling a module re-renders the injected file, so a disabled section really stops
    being injected.
  - Project rules render into a new **§8** of `AGENTS.md`: a table of global `G*` and project
    `P-*` rows, plus the inline body of every enabled rule. `ai_check` reports drift
    (`on-rule` / `off-rule` / registry unreadable).
- Cross-session handoff: new `ai_handoff` tool (`read` / `write` / `inherit`) and
  `.ai/SESSION_BOOT.md`, regenerated by `ai_log`, `ai_init` and `autoInit`. It carries the status
  snapshot, the most recent records, the discipline list, and an inheritance prompt for a new
  session. `read` returns the file text itself (generating the file first if it is missing).
- Concurrency and file protection: `lib/atomic.js` (temp file + `fsync` + rename, retry on
  `EPERM`/`EBUSY`/`EACCES`) and `lib/lock.js` (cross-process lock with stale detection).
  `ai_log` holds `.ai/.log.lock` across the append and status update; `status.json` gains a
  `rev`; `TASKS.md` and `SESSION_BOOT.md` are written atomically. `template/.ai/llm.ps1` gets
  `Write-TextAtomic` + `Enter-ProjectLock`/`Exit-ProjectLock` for `add`, `tasks`, `board` and
  `archive` (archive aborts if the log grew during the copy). `install.ps1` writes `AGENTS.md`
  atomically and backs it up to `.ai/backups/` (last 10) before any change.
- Tests: 25 (tool contract, config, task rendering, AGENTS.md preservation, atomic/lock,
  discipline registry and §8 drift, handoff).
- Verified on a real workspace: project rule add/disable/enable/remove, global module
  disable/enable (bytes 5900 → 5671 → 5900), 12 concurrent writers → 12 records with `rev=12`,
  6 concurrent `llm.ps1 add` calls without loss.
- Docs: README gains a "What's new in 0.5.0" summary and the discipline/concurrency sections;
  `docs/DETAIL.md` and the visual introduction page are refreshed for 0.5.0.

## 0.4.4

- Docs/legal: add `docs/DISCLAIMER.md` (AS IS, limitation of liability, backup guidance)
  and `docs/NONCOMMERCIAL-NOTICE.md` (advisory non-commercial request). `LICENSE` stays MIT;
  both notices state that MIT permits commercial use and the request is not a license condition.
- README: License section links both documents; status line now notes the bundle is listed in
  the community plugin market (it was already listed; the text was stale).
- Republish so the npm README shows the **Visual introduction** link
  (<https://zhuyw3927.github.io/dsh-ai-collab/>), which was added after 0.4.3.
- `docs/index.html` refreshed to 0.4.4 and links the disclaimer / non-commercial notice.
- No runtime behaviour changes.

## 0.4.3

- Published to npm as `dsh-ai-collab@0.4.3` (2026-11-17).

- Repository metadata: `repository`, `homepage`, `bugs` point at the public GitHub repository;
  `README` carries the CI badge; `.gitignore` added for release artifacts.
- Market checklist updated now that the repository exists.

## 0.4.2

- Desensitize shipped files: example paths, project names, hostnames and an internal SVN URL
  are replaced with placeholders; `placeholders.sample.json` uses a neutral demo project and
  the v2 `.ai\` directory.
- Market preparation: `docs/MARKET.md` release checklist, `scripts/make-market-index.mjs`
  (format-1 index generator), `publishConfig.access`.

## 0.4.1

- Declare `"os": ["win32"]`: the bundle is Windows-only for now (scaffolding runs Windows
  PowerShell 5.1). macOS/Linux return `unsupported-platform` and are not supported yet.
- README and detail document state the platform restriction explicitly.

## 0.4.0

- Security: task-list refresh is rendered inside the plugin; it no longer executes the
  workspace's `.ai/llm.ps1` (a cloned repository could otherwise run code on `ai_log`).
- Config: values are normalised and validated (`autoInit`, `maxTail`, `initScript`);
  rejected values produce warnings in `$DSH_HOME/logs/ai-collab-config.log`.
- Cross-platform: `workingDirectory` is no longer a hard injection; scaffolding reports
  `unsupported-platform` instead of failing silently outside Windows.
- Reliability: per-workspace in-flight guard for auto-adoption, debounced board refresh,
  256 KiB log rotation, and clearer error entries.
- Packaging: locale metadata (`en`, `zh`), SVG icon, `meta.detail`, `engines.dsh`,
  display-ready `files`, and a user-level `AGENTS.global.template.md`.
- Tests: new pure-JS tests for config normalisation and task rendering.

## 0.3.6

- `ai_log` refreshes `TASKS.md` after a record; `ai-ensure` refreshes any workspace with
  `.ai/tasks-enabled`.
- AGENTS.md zones: only the generated zone is replaced; the user zone is preserved.

## 0.3.0

- Tools resolve the session working directory through `ctx.workingDirectory`.
- `ai_init` and auto-adoption run `ai-ensure` and return its parsed result.

## 0.2.0

- First working bundle: five tools, heartbeat and tool-registration logs, Windows scaffolding.
