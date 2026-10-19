# Memory 快照 — 回滚指南（G2）

> 熵控制方案 [C15]（[English](../en/memory-snapshot.md)）。
> 快照是尽力而为的基础设施：fail-open、内容去重、轮转——它永不阻塞会话、永不自动回滚。

## 快照了什么

每次 `session_start` 对两层 memory 全量快照：

```
~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/        ← USER 层
~/.pi/agent/cc-core/memory-snapshots/project-<sanitized-root>/snap-<ts>-<rand>/   ← PROJECT 层
```

每个快照目录含全部 memory 文件 + `manifest.json`（`at`、`contentHash`、`files[]`、`totalBytes`）。与最近一份内容相同则跳过；保留最新 **10** 份（`extensions/memory/snapshot.ts` 的 `SNAPSHOT_KEEP`）。

## 从快照恢复

```sh
# 1. 列出快照（新的在后）并挑一份
ls -lt ~/.pi/agent/cc-core/memory-snapshots/user/
cat ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/manifest.json

# 2. 预览会恢复哪些文件
ls ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/

# 3. 把要恢复的文件拷回活跃层
cp ~/.pi/agent/cc-core/memory-snapshots/user/snap-<ts>-<rand>/*.md \
   ~/.pi/agent/memory/

# 4. 重建派生索引（MEMORY.md）
#    —— 最简单：重启 pi（session_start 会重扫重建），或跑 /memory
```

PROJECT 层的活跃目录是 `~/.pi/agent/projects/<sanitized-repo-root>/memory/`（精确路径见 `/memory` 面板头部）。

## 什么时候需要它

- agent_end 提示 "lost N file(s) … without memory_consolidate" 且确实不是你手动删的。
- 一次 consolidation 合错了，想要合并前的文件。
- 本次 session_start 之后发生的意外批量删除。

快照不追踪会话中途的编辑（只记 session_start 时刻的状态）；最新快照永远是「本会话开始时的状态」。
