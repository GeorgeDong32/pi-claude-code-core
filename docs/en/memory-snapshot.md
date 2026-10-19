# Memory Snapshots — Rollback Guide (G2)

> [C15] of the entropy-control spec ([中文版](../zh/memory-snapshot.md)).
> Snapshots are best-effort infrastructure: fail-open, deduped, rotated —
> they never block a session and never auto-rollback.

## What gets snapshotted

At every `session_start`, both memory layers are copied in full:

```
~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/        ← USER layer
~/.pi/agent/cc-core/memory-snapshots/project-<sanitized-root>/snap-<ts>-<rand>/   ← PROJECT layer
```

Each snapshot dir holds every memory file plus a `manifest.json`
(`at`, `contentHash`, `files[]`, `totalBytes`). Identical content skips the
snapshot; the newest **10** are kept (`SNAPSHOT_KEEP` in
`extensions/memory/snapshot.ts`).

## Restoring from a snapshot

```sh
# 1. list the snapshots (newest last) and pick one
ls -lt ~/.pi/agent/cc-core/memory-snapshots/user/
cat ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/manifest.json

# 2. preview what would come back
ls ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/

# 3. copy the files you want back into the live layer
cp ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/*.md \
   ~/.pi/agent/memory/

# 4. rebuild the derived index (MEMORY.md)
#    — easiest: restart pi; the session_start reconciler reindexes, or run /memory
```

For the PROJECT layer, the live dir is
`~/.pi/agent/projects/<sanitized-repo-root>/memory/` (the exact path shows
in the `/memory` panel header).

## When you need this

- The agent_end notice "lost N file(s) … without memory_consolidate"
  fired and the loss was NOT your own manual edit.
- A consolidation went wrong and you want the pre-merge files back.
- Any accidental mass deletion since the last session start.

Snapshots do not track edits made mid-session (only the session_start
state); the newest snapshot is always "the state when this session began".
