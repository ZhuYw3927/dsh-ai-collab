# dsh-ai-collab

A DeepSeek Harness bundle that gives every AI tool in a repository the same project memory (visual introduction: <https://ZhuYw3927.github.io/dsh-ai-collab/>):
one `AGENTS.md` entry file and one hidden `.ai/` folder holding an append-only work log,
a current-state snapshot, and version-level change notes.

## Why

Every new session spends its first minutes rediscovering the build command, the read-only
folders, and what the previous session changed. `dsh-ai-collab` turns that into two plain
files that any tool can read: `AGENTS.md` for facts, `.ai/log.jsonl` for history.

## What it adds

| Capability | Detail |
|---|---|
| Five tools | `ai_status`, `ai_log`, `ai_check`, `ai_board`, `ai_init` |
| Auto-adoption | On `session/created` (`autoInit: true`) run `ai-ensure` in non-temp directories: scaffold when missing, upgrade when the template changed, refresh the board when stale |
| Zoned `AGENTS.md` | A `generated` zone (routing, permissions, commands) replaced on upgrade, and a `user` zone (project facts, sampling data, analysis methods, decisions) preserved byte-for-byte |
| Protected files | An `AGENTS.md` without zone markers is treated as project-owned and never rewritten; the rendered reference goes to `.ai/AGENTS.generated.md` |
| Task list | When `.ai/tasks-enabled` exists, `ai_log` and `ai-ensure` refresh `TASKS.md` at the workspace root |
| Cross-project board | When a sibling `.ai/board.md` exists, the board is refreshed after a record is written |

## Install

- **Plugin Manager (recommended):** Plugins → Add plugin → select this package directory.
- **CLI:** `dsh plugin --profile <profile> add <package path or npm name>`
- Restart DSH once; every session in the profile then exposes the five tools.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `autoInit` | `false` | Adopt/refresh the session working directory on session creation |
| `maxTail` | `10` | Number of recent records returned by `ai_status` |
| `initScript` | packaged `ai-ensure.ps1` | Override the adoption script (debugging) |

Values are normalised and invalid values are reported as warnings in
`$DSH_HOME/logs/ai-collab-config.log`; they are never silently used as-is.

## The `.ai/` layout

```
<project root>
├─ AGENTS.md              generated zone + user zone
├─ TASKS.md               optional task list
└─ .ai/
   ├─ llm.ps1 / llm.cmd   status / tail / add / check / board / doctor / tasks
   ├─ log.jsonl           append-only, UTF-8 without BOM, LF
   ├─ status.json         current-state snapshot (overwritten)
   ├─ LOG_FORMAT.md / SECURITY.md / schema/log.schema.json
   ├─ changelog/           version-level notes and patches
   ├─ entries/             forwarding masters for Claude Code / Gemini CLI
   └─ _archive/
```

A record is one JSON object per line:

```json
{"id":"20261117T062049123-ab12cd","ts":"2026-11-17T14:20:49+08:00",
 "tool":"deepseek-harness","actor":"ai","action":"fix","status":"ok",
 "summary":"...","files_modified":["src/a.c"],"verification":"rebuild 0/0"}
```

## Safety

- The log is append-only; corrections are new records (`action: "correction"`).
- Adoption writes only into the workspace, never into system or temp directories.
- The plugin performs no network requests and stores no credentials.
- Task rendering runs inside the plugin; it never executes a workspace-provided script.

## Compatibility

- DSH `0.2.1+` (tested on `0.2.2-rc.3`).
- Node.js `>= 20` (the bundled Electron Node works).
- **Windows 10/11 only for now.** Scaffolding (`ai_init`, `autoInit`) runs Windows PowerShell 5.1;
  the package declares `"os": ["win32"]`. The read-only tools and task rendering are
  platform-neutral, but macOS/Linux are not supported or tested yet.

## Known limitations

- The scaffolding scripts are Windows-only; other platforms get the read-only tools.
- The bundle declares no display icon fallback for hosts older than the locale/meta support.
- A legacy `AGENTS.md` without zone markers is frozen by design; migrate explicitly with
  `install.ps1 -ForceAgents` (moves old content into the user zone) or `-ResetAgents`.

## License

MIT. MIT permits commercial use.

- [Disclaimer](DISCLAIMER.md) — the software is provided "AS IS", without warranty; back up
  your workspace and review generated changes before committing.
- [Non-commercial request](NONCOMMERCIAL-NOTICE.md) — the author asks you to prefer
  non-commercial use. This is a request, not a license condition; MIT still grants
  commercial rights and the notice adds no restriction.

Using the bundle means you have read and accepted the disclaimer.
