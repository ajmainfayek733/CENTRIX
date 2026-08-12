# MemPalace wiring

How cross-session memory works in this repo, and what to do when it misbehaves.

## The two halves

MemPalace has a **write** path and a **read** path. They are configured in different
places, and only the write path ships working.

| Half | Mechanism | Where it is configured |
| --- | --- | --- |
| Write (automatic) | `Stop`, `SessionEnd`, `PreCompact` hooks | plugin: `~/.claude/plugins/cache/mempalace/mempalace/<version>/hooks/hooks.json` |
| Write (deliberate) | `mempalace_checkpoint` MCP call | agent behaviour, prompted by the recall header |
| Read (automatic) | `SessionStart` hook | this repo: `.claude/settings.json` |

### Why the read half is ours

MemPalace ships a `session-start` hook, but it is a no-op —
`mempalace.hooks_cli.hook_session_start` creates a state directory and returns `{}`. It
never injects anything. Until 2026-08-12 nothing read the palace back at session start,
so an agent starting fresh had no memory of prior work and would fall back to
reconstructing history from `git log`.

`.claude/hooks/mempalace_recall.py` fills that gap.

## What the recall hook does

1. Runs `mempalace wake-up --wing wing_employee_tracker`.
2. Strips harness noise (see below).
3. Returns the survivors as `hookSpecificOutput.additionalContext`.

It is registered on `startup|resume|clear` with a 25 s timeout. **Every failure path
returns `{}`** — a broken palace, a missing CLI, or a hung query can never block a
session from starting.

### Noise filtering

The transcript miner files raw message text, so the palace accumulates content with no
recall value. `hooks_cli` filters `<command-message>` and `<system-reminder>`, but only
for the diary, and nothing filters the ingest path. Before filtering, a wake-up was
roughly 90% noise. The hook strips:

- `<local-command-caveat>`, `<local-command-stdout>`, `<command-message>`,
  `<system-reminder>`, `<task-notification>`
- MCP chatter: `Reconnected to …`, `Failed to reconnect …`
- Build artifacts: `/obj/`, `/bin/Debug/`, `*.AssemblyInfo.cs`, `*.GlobalUsings.g.cs`,
  `node_modules/`
- Directory-listing spam — any line with 3 or more `→` separators
- Section headers left empty after their body was filtered

Output is capped at `MAX_BODY_LINES` (40) and `MAX_CONTEXT_CHARS` (6000).

## Windows encoding traps

Two real bugs were hit building this, both worth remembering:

- **`subprocess.run(text=True)` decodes with the ANSI codepage.** The CLI emits UTF-8
  em-dashes and arrows, so the hook raised `UnicodeDecodeError` and silently degraded to
  `{}`. Fixed with an explicit `encoding="utf-8", errors="replace"`.
- **Filed drawers can carry unpaired surrogates** (e.g. `\udc9d`) because transcript
  readers use `surrogateescape`. Those cannot be encoded as UTF-8 and abort the hook, so
  `_sanitize()` scrubs them before emit.

`~/.mempalace/identity.txt` supplies the L0 identity block and **must stay ASCII-only** —
`wake-up` reads it with the system ANSI codepage and mojibakes anything else.

## Operating it

```bash
# See what a new session will be given
mempalace wake-up --wing wing_employee_tracker

# Exercise the hook exactly as Claude Code will
echo '{"hook_event_name":"SessionStart","source":"startup"}' \
  | python .claude/hooks/mempalace_recall.py

# Palace health. Rebuild from SQLite if divergence is non-zero
mempalace status
mempalace repair-status
```

Disable recall for one session with `MEMPALACE_RECALL_DISABLED=1`.

If a session starts with no "MemPalace recall" block, the hook failed — investigate
rather than assuming the palace is empty.

## Filing knowledge

The automatic hooks only capture raw transcript text. Anything that should survive as
knowledge must be written deliberately with `mempalace_checkpoint` — verbatim items plus
one AAAK diary entry, wing `wing_employee_tracker`. The recall header reminds the agent
to do this at session end.

Never delete drawers by writing to `chroma.sqlite3` directly; that desyncs the HNSW
index. Use `mempalace_delete_drawer`, which write-ahead-logs each deletion first.

## History

On 2026-08-12 a scan found 43 of 564 drawers were pure harness noise (session
transcripts of MCP reconnect messages, slash-command echoes, and .NET build-artifact
path chains). They were purged through the WAL-logged MCP path, leaving 526. Index
divergence after the purge: 0.
