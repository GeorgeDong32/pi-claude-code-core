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
状态行（BG-ENTRY-03）：每次完成与每次用户 kill 都追加一条 display-only
的 session entry（`pi.appendEntry`——不进 LLM）。CH E5：对已结束的任务
执行 TaskStop 时，最多追加一行、写真实结束状态与 exitCode——除非确有
kill 终止了它，否则不写 `killed`；状态行已追加过（`notified`）则不再
追加。渲染归
pi-claude-code-tui（`lib/bg-task-row.ts`）：`⏺ Background Task(bg-N)`
伪工具行 + `⎿` 明细 gutter，状态色圆点，与 agent 随后的 TaskOutput 行
视觉成对（对齐 CC `task_status`，resume 时重放）。core 刻意不注册
renderer——first-wins 下会永久遮蔽 TUI 的。独立 watcher 进程（任务组外）在 pi 死亡时杀掉任务组。

## 工具面（CC-parity 命名，BG-D3）

| 工具 | 用途 |
|---|---|
| `bash`（覆盖） | 增加 `background` / `waitFor` / `description`（短人话标签，对齐 CC——随 id 显示在所有任务列表处）；不带时即 pi 原生 bash 走同一 wrapper |
| `TaskOutput` | 从任务读位置增量读取；`latest` 跳到最新、`filter` 正则过滤；可选 `block: true` 先等任务结束——至多 `timeout` 秒（默认 30、上限 600，超上限直接报错），用户插话则提前结束等待、返回已有输出 |
| `TaskStop` | 对进程组 SIGTERM → 宽限 → SIGKILL；随后不再发完成消息 |
| `TaskList` | 每任务一行：id、状态、时长、命令 |

模型通过 `TaskOutput` 读取已结束的任务时，读取本身即认领通知（对齐 CC
的 `markTaskNotified`）：工具结果已携带输出与退出状态，不再补发冗余的
完成消息——否则该消息会排在发起读取的那轮 turn 之后、迟到且重复。
自 E4（SPEC SR，2026-11-15）起，认领改走 registry 的 `claimCompletion`，
按其余完成同样的方式上报（只是不发消息）：追加状态行（BG-ENTRY-03），
进程组退出后压缩日志——读取落在退出与下次轮询之间时，任务不再漏报。
阻塞式 `TaskOutput`（`block: true`）等待期间持有任务（`waiting` 计数），
轮询与任何 kill 路径都不会在其下方向它发完成消息——由等待者认领；等待在
认领前被中止时 `notified` 保持 false，由下一次轮询正常上报。

`/tasks` 打开管理面板（TUI：enter 看输出、x 确认后杀、q/esc 关闭、1 秒刷新；
RPC 降级 `ui.select`；无 UI 打印列表）。`ctrl+shift+b` 把前台运行中的调用
转后台；前台调用超 120 秒（`sleep` 除外）自动转后台。显式 `timeout` 不再
关闭该自动转后台（BH-R4，D-BH-2——不猜单位：模型常把毫秒当秒传，120 秒
安全网必须保持有效）：调用仍在 120 秒转后台，timeout 变为该任务的截止
时间，与 `background: true` 一致；小于阈值的 timeout 仍按前台超时硬性终止。

## 加固（继承自上游，原样保留）

- 退出 marker 携带每任务 nonce —— 输出内容无法伪造（sanitize 把 marker 从
  模型可见的一切里剥掉）
- 100 MiB log 上限 → kill + `__CC_BG_LIMIT__` marker；gzip 只在完成消息
  发出之后
- `session_shutdown(reason === "reload")` 保留任务，其余结束方式全杀
- resume：id 跳过已有 log/`.log.gz` 的 `bg-<n>`；且 `session_start` 用
  session 状态行里已记录的 id 抬高计数（CH E6）——日志被 7 天清理后
  编号不再重置回 `bg-1`
- CH E2：`"…" never appeared` 提示只保留在转后台那条路径；正常退出与
  报错两条路径不再追加（模型传占位 waitFor 值时该提示泛滥），且
  `waitFor` 参数说明明确告知不等待时应省略该参数

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

CC 的 `TaskOutput` 默认阻塞，`timeout` 以毫秒计。core 的 `block` 默认
false（完成通知本就会唤醒空闲的 agent，普通读取才是常见路径），`timeout`
以秒计——默认 30、上限 600；超过上限直接报错
（`timeout is in seconds (not ms); maximum is 600`）而不截断，不带
`block: true` 传 `timeout` 同样报错（E4，D-SR-3）。

## 与上游 pi-bg-bash 的已知偏离

上游 0.5.0+ 完全移除了基于定时器的自动转后台（只剩 `waitFor` 命中与用户
快捷键两种晋升）。core 保留自动转后台，且自 BH-R4 起扩展到带显式
`timeout` 的调用（timeout 成为该任务的截止时间）——这是刻意的 vendor
偏离（D-BH-2；见 DEVIATIONS）。上游完全没有阻塞式 `TaskOutput`：
`block`/`timeout` 与读取即认领的上报（状态行 + gzip）都是 core 新增
（E4，SPEC SR）。
