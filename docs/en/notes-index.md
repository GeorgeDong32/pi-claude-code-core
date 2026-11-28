# notes-index — the only memory feature core keeps

Since 2026-11-28 the `memory` module (automatic extraction, recall selection,
consolidation, queue/drain, lookup/search tools, stats) is gone. The Obsidian
vault under the user's global AGENTS.md is the memory system every agent
shares ("Agent Notes"); capture is the AGENTS.md discipline plus a nightly
dream agent run outside core. Core does one thing: it injects an index of the
notes directory at session start, so the model knows what exists without
being told, and reads notes on demand with `rg`/`read` like any other agent.

## What is injected

On `before_agent_start` (user and custom-message runs alike) one block is
appended to `systemPrompt`:

```
# Project notes

Directory: <dir> — read a note with rg/read when a row is relevant.

## Pinned memories (always active)

### <name>

<body>

- <slug> — <description>
…
… +N more
```

- Pinned notes come first: `pinned: true` in the frontmatter, from the notes
  directory and from the global pinned directory. Caps: 5 files, 2,000 bytes
  in total, body ≤ 1,200 chars; a dropped-pinned note is announced in a
  comment. Pinned notes that were rendered are not repeated as rows.
- Rows are built from each `*.md` file's frontmatter (`name`, `description`),
  sorted by slug, byte-capped by `MEMORY_INDEX_MAX` (25,000, `lib/context-budget.ts`);
  a `… +N more` row closes a truncated list. A note without frontmatter falls
  back to its first heading, otherwise to `(no description)`; a description
  over 80 chars carries a `⚠`. `MEMORY.md` and `index.md` are navigation, not
  notes. Nothing is rejected and nothing is rewritten.
- The block is built once per session and rebuilt only after a compaction, so
  the system prompt does not move mid-session (KV cache). A read error yields
  no block and one warning — never a failed turn.

## Directory resolution

1. `~/.pi/agent/core-economy.json` → `notesIndex: { enabled?: boolean, dir?: string, pinnedDir?: string }`
   (`enabled: false` turns the module off; `dir` and `pinnedDir` are absolute
   paths, blank means unset).
2. Default: `~/.pi/agent/projects/<sanitizePath(git root or cwd)>/memory`
   — keyed by the **git root**, so a session opened in a repository
   subdirectory sees the same notes as one at the root. Default pinned
   directory: `~/.pi/agent/memory`.
3. A missing directory → no block, no warning.

Pointing `dir` at `Agent Notes/<host>-<project>/` inside the Obsidian vault
makes the vault the store. Core never writes into the notes directory: writes
follow the normal permission path (no approval carve-out, no bash protection).

## Related

- `extensions/session-recall/` — the `session_recall` tool (codemode), which
  searches past session logs; it moved out of `memory` unchanged.
- `extensions/modes/protected-writes.ts` — the [C4] self-modification guard
  (write/edit block on pi's governance files + sha256 baseline warning), which
  also moved out of `memory`; see [modes.md](modes.md).
- Old session files that carry `pi-memory-recall`, `pi-memory-status` or
  `cc-core-memory-stats` entries still load (`test/contracts/legacy-memory-entries.test.ts`).
