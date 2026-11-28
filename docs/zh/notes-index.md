# notes-index —— core 保留的唯一记忆能力

2026-11-28 起 `memory` 模块(自动提取、recall 选择器、整合、队列/drain、lookup/search 工具、统计)整体下线。所有 agent 共享的记忆系统是全局 AGENTS.md 下的 Obsidian vault(「Agent Notes」);捕获靠 AGENTS.md 纪律加 core 之外的夜间 dream agent。core 只做一件事:会话开始把笔记目录的索引注入 system prompt,让模型不用被提醒就知道有什么;读笔记和其他 agent 一样用 `rg` / `read`。

## 注入什么

`before_agent_start`(user 与 custom-message run 一视同仁)追加一块到 `systemPrompt`:

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

- 置顶笔记在前:frontmatter 里 `pinned: true`,来源包括笔记目录和全局置顶目录。上限:5 个文件、总计 2,000 字节、正文 ≤ 1,200 字符;被丢弃的置顶笔记用注释说明。已渲染的置顶笔记不再重复成行。
- 行由每个 `*.md` 的 frontmatter(`name`、`description`)生成,按 slug 排序,受 `MEMORY_INDEX_MAX`(25,000,`lib/context-budget.ts`)字节上限约束;截断时末尾补一行 `… +N more`。没有 frontmatter 的笔记退化为第一个标题,否则 `(no description)`;描述超过 80 字符带 `⚠`。`MEMORY.md` 与 `index.md` 是导航不是笔记。不拒绝、不改写任何文件。
- 每个会话只构建一次,只在 compaction 之后重建,所以 system prompt 会话中途不动(KV 缓存)。读取出错时没有块、只警告一次,绝不打断回合。

## 目录解析

1. `~/.pi/agent/core-economy.json` → `notesIndex: { enabled?: boolean, dir?: string, pinnedDir?: string }`(`enabled: false` 关闭模块;`dir`、`pinnedDir` 为绝对路径,空白视为未设)。
2. 默认:`~/.pi/agent/projects/<sanitizePath(git 根或 cwd)>/memory`——按 **git 根**键控,仓库子目录里开的会话和根目录开的看到同一份笔记。默认置顶目录:`~/.pi/agent/memory`。
3. 目录不存在 → 没有块,也不警告。

把 `dir` 指向 Obsidian vault 里的 `Agent Notes/<机器名>-<项目>/`,vault 就是存储。core 不往笔记目录写任何文件:写入走普通权限路径(没有免审批例外,也没有 bash 保护)。

## 相关

- `extensions/session-recall/` —— `session_recall` 工具(codemode),搜索历史会话日志;从 `memory` 原样拆出。
- `extensions/modes/protected-writes.ts` —— [C4] 自修改边界(write/edit 对 pi 自身治理文件的阻断 + sha256 基线告警),同样从 `memory` 拆出;见 [modes.md](modes.md)。
- 带 `pi-memory-recall`、`pi-memory-status`、`cc-core-memory-stats` 条目的旧会话文件仍能加载(`test/contracts/legacy-memory-entries.test.ts`)。
