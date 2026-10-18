# bg-shell — 后台 Shell 任务

> 中文. English: [../en/bg-shell.md](../en/bg-shell.md)

**目录**: `extensions/bg-shell/`
**来源**: vendor 自 `gvanderclay/pi-bg-bash` v0.2.1（MIT），Copyright (c) 2026 Gage Vander Clay — 为 core 改造（BG-D1）

## 做什么

给模型的 `bash` 工具加 `background: true` 标志（以及 `waitFor`）。
后台调用把命令以独立进程组 detached 启动，stdout+stderr 追加到会话 log，
立刻返回任务 id：

```
~/.pi/agent/cc-core/logs/bg-shell/<sessionId>/bg-<n>.log   （0700，owner.pid 属主标记）
                                                          （完成后 .log.gz）
```

命令退出时 agent 收到**一条完成消息**（customType `cc-core-bg-shell`，
`deliverAs: "followUp"`，`triggerTurn: true`，`display: false`），携带退出
状态、运行时长与输出指针——**不含输出本身**（对齐 CC
`<task_notification>`：通知只有摘要，模型自己用 `TaskOutput` 读输出，
于是 TUI 里出现工具调用行）——agent 空闲时自动开 turn，
模型因此永远不需要 sleep 轮询。通知仅模型侧可见（对齐 CC
`task_notification`）：TUI 不渲染 `[cc-core-bg-shell]` 块。用户侧可见面是
状态行（`status-entry.ts`，BG-ENTRY-03）：每次完成与每次用户 kill 都追加
一条 display-only 的 session entry（`pi.appendEntry`——不进 LLM），流内渲染
`⏺ Task "cmd" completed in background`——状态着色圆点（success/error，工具行圆点同款语言）+ dim 正文（对齐 CC `task_status`
attachment），先于 agent 回复显示，resume 时重放。独立 watcher 进程（任务组外）在 pi 死亡时杀掉任务组。

## 工具面（CC-parity 命名，BG-D3）

| 工具 | 用途 |
|---|---|
| `bash`（覆盖） | 增加 `background` / `waitFor`；不带时即 pi 原生 bash 走同一 wrapper |
| `TaskOutput` | 从任务读位置增量读取；`latest` 跳到最新、`filter` 正则过滤 |
| `TaskStop` | 对进程组 SIGTERM → 宽限 → SIGKILL；随后不再发完成消息 |
| `TaskList` | 每任务一行：id、状态、时长、命令 |

模型通过 `TaskOutput` 读取已结束的任务时，读取本身即认领通知（对齐 CC
的 `markTaskNotified`）：工具结果已携带输出与退出状态，不再补发冗余的
完成消息——否则该消息会排在发起读取的那轮 turn 之后、迟到且重复。

`/tasks` 打开管理面板（TUI：enter 看输出、x 确认后杀、q/esc 关闭、1 秒刷新；
RPC 降级 `ui.select`；无 UI 打印列表）。`ctrl+shift+b` 把前台运行中的调用
转后台；前台调用超 120 秒（`sleep` 除外）自动转后台。

## 加固（继承自上游，原样保留）

- 退出 marker 携带每任务 nonce —— 输出内容无法伪造（sanitize 把 marker 从
  模型可见的一切里剥掉）
- 100 MiB log 上限 → kill + `__CC_BG_LIMIT__` marker；gzip 只在完成消息
  发出之后
- `session_shutdown(reason === "reload")` 保留任务，其余结束方式全杀
- resume：id 跳过已有 log/`.log.gz` 的 `bg-<n>`

## 环境变量（测试缝，非用户配置）

`CC_CORE_BG_DEBUG=1`（JSONL 调试日志）、`CC_CORE_BG_PROMOTE_MS`、
`CC_CORE_BG_GRACE_MS`、`CC_CORE_BG_LOG_LIMIT_BYTES`。

## 契约

`BG-DISK-01`（log 布局，cc-core 统一 logs 根）与 `BG-MSG-02`（完成消息
customType）——见 `test/contracts/README.md`。

## 与 CC 的已知偏离

CC 的 `/tasks` 还列 agent/teammate/workflow 任务并提供 `f`（重挂前台）。
我们只管 shell 任务，且 pi 没有 turn 内重挂机制——两者都是刻意的范围裁剪
（DEVIATIONS）。
