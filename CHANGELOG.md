# Changelog

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
