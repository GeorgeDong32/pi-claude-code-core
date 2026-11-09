# SPEC SC：Smart Compaction — 接管式压缩控制器

| 项 | 值 |
|---|---|
| 日期 | 2026-11-08 |
| 状态 | **READY（v2.1，2026-11-09）— W0 已交付**（2026-11-09：S1–S5 结论回填 §4.3/§5.9a、BLK-1…5 基线+expected-fail 保护断言落地、契约 §8 全登记；三门全绿）。其余任务按 §6 批次推进（W1/W5 可派）。v2.1 = R1 评审修订（附录 D）+ 用户补充开放点 O1/O2 + 2026-11-09 真实宿主冒烟（S1 / BLK-1 / BLK-2 已复现，§4.4 末） |
| 目标仓 | pi-claude-code-core（新模块 `extensions/compaction/`，第 14 个模块） |
| 宿主 | pi `@earendil-works/pi-coding-agent` **1.5.0**（本 spec 的宿主事实均在此版本核实） |
| 取代 | [`2026-11-08-smart-compaction.md`](2026-11-08-smart-compaction.md)（候选 A 草案，未实施；其 §2 的 pi 源码取证仍可参考） |
| 参考 | SoL-Pi Online Context Compact（NVlabs/SoL-Pi，commit `2195680`）；rex-flow 协议（`rex-flow-shared` §2/§4/§6） |

> **读法**：§1–§3 说明为什么、做什么、不做什么；§4 是宿主事实与待验证项；§5 是设计与**可验收需求表**（每条需求 = ID + 要求 + 验收方式）；§6 是派工拆分（文件所有权、依赖、批次）；§7 是验收矩阵；§8–§11 是契约/文档/风险/回滚。派工者只需读 §0、§3、§6 与自己任务引用的需求 ID。

---

## 0. 一页摘要

**一句话**：由 core 扩展接管**常规**压缩——在 pi 原生阈值之前，后台预先生成摘要（与主对话并行），在安全边界用 `turn_end` / `agent_before_settle` 返回的 compaction draft **提议**落盘（不 abort、不等待、无 spinner），并以**宿主实际提交**为准确认（`ready → proposed → committed`，§5.2/§5.7）；摘要内含**确定性台账**（结构化开放状态不丢、已完成任务一行、用户指令在预算内逐字，保障范围见 §5.6 LED-08）；原生压缩只保留给 `/compact` 手动与 overflow/threshold 兜底，并在兜底时复用已备好的摘要（但**永远先过硬容量闸 V8a**）。

**三条安全边界（评审 R1 后升级为阻断性）**：① 不得吞掉原生的截断/overflow 恢复（POL-07）；② 提议≠提交，快照与订阅方通知只认已确认的提交（APP-05/08）；③ 任何路径写入的压缩结果，下一次请求必须装得下（V8a）。三者均由 W0 的真实宿主（`createAgentSession` + faux provider）阻断性用例钉死（§4.4）。

**为什么不是"回填"**：旧草案（候选 A）等原生触发后再回填，压缩点仍由原生阈值决定，且不解决"摘要质量/多任务丢失"。本 spec 把控制权拿回来，原生降为兜底腿。

**三个场景 → 机制**

| 场景 | 痛点（本地数据） | 机制 |
|---|---|---|
| ① 单任务 >5h | 原生压缩点 = token 距离，落在哪算哪；goal 会话 6325 条目仅 4 条 user，无 user 边界 | 语义切点评分（goal step / commit / 测试通过 / 空闲间隔 / 回合边界）+ 指令原文与验证状态台账 |
| ② 面向用户的 orchestrator（rex-flow） | 压缩后 run/task 状态丢失，模型重读 board 数十次 | rex-flow 台账：开放 run 全量、已闭环 run/task 一行；run 闭环作为最高优先级切点 |
| ③ 通用长对话 | 每次自动压缩阻塞约 55–170s | 后台预压 + 原子落盘；用户感知等待趋近 0 |

---

## 1. 背景与取证（一手数据，仅用元数据）

采样口径：本机 372 个、第二台机器 111 个 pi 会话 jsonl，只读元数据（时间戳、条目类型、`tokensBefore`、usage、字符长度、标记字符串出现次数）；**不拷贝任何正文进仓库**。数据是观察性的、样本小，**只用于说明动机与校准默认值，不构成统计结论**；所有数值型默认值见附录 C，由 W2 回放校准。

| # | 观察 | 数据 | 驱动的需求 |
|---|---|---|---|
| E1 | 原生压缩是阻塞的 | 压缩条目与前一条目的间隔 ≈ 53–171s（剔除含空闲的离群值），摘要输入 68K–658K tokens（大压缩典型 270K–520K），输出 3K–11K tokens | §5.7 落盘不等待 |
| E2 | 触发点很高 | `tokensBefore` 密集于 ≈ 500K（用户设置 `reserveTokens=500000`）；另有一次 984K | 阈值必须取自**有效** reserve（含 modelOverrides），不得写死（POL-01） |
| E3 | 原生会落盘"空摘要" | 一次 511K 上下文的压缩：输出 1903 tokens 全是 reasoning，`summary` 仅剩文件列表（970 字符），原生照常落盘 | 摘要校验闸 + 摘要调用关 thinking（SUM-03/04） |
| E4 | 会话形态 | 单任务 goal 会话 6325 条目 / 4 条 user；rex-flow orchestrator 会话 97–159 条 `FLOW-REPORT` 哨兵、活跃 ≥6–14h；活跃 ≥5h 的会话 8 个 | 无 user 边界也要有切点（CUT-05）；orchestrator 台账 |
| E5 | 被压区成分 | assistant ≈ 31–59%，bash 结果 ≈ 32–57%，read ≈ 3–18% | 摘要输入以 assistant/bash 为主；不另做工具结果特化 |
| E6 | 多任务状态丢失 | orchestrator 压缩前后：一个 run id 压缩前 15 次提及、摘要 0 次、压缩后仍被引用；`board.json`/`merged`/`rework`/`escalate` 压缩前 38/90/73/31 次、摘要均未出现；压缩后 `flow-board` 在 33 个条目中出现（大量重读 board） | rex-flow 台账（LED-05）；摘要模板需区分 open/closed（LED-06） |
| E7 | 增长速率与摘要耗时的关系 | 活跃 15h / 2 次压缩 ≈ 每 500K 约 7h；摘要耗时 ≈ 1–3 分钟 | 预压窗口（0.60→0.75·T_n）远大于摘要耗时 |
| E8 | rex-flow 目录命名并不统一 | 文档写法 `~/.rex-flow/projects/--<sanitized-root>--/`；实测第二台机器为无破折号目录（且以 ws_root 命名），并与旧布局 `~/rex-flow/{boards,dispatch,evidence,ws}` 并存；本机仅有 `projects/tmp-flow-e2e/`。`board.json` 顶层键 `deploy/worker_defaults/runs/tasks/gates/updated` 已实测 | board 发现不得硬编码单一命名（LED-05） |

---

## 2. 目标、度量、非目标

### 2.1 目标

| # | 目标 | 度量（如何证明） |
|---|---|---|
| **G1 无感** | 自动压缩（threshold 类）对用户的阻塞 ≈ 0：落盘路径**无 LLM/网络等待**，无 spinner，不 abort 当前 run | APP-03（同步、`applyMs` 上界）；H-SC-1（真机无 `compaction_start`） |
| **G2 接管** | 常规压缩由控制器完成；原生阈值压缩成为例外 | W2 回放 **M1 = 阈值前成功提交率**（越过原生阈值的压缩事件中，已在阈值前**提交**的占比；校准目标 ≥ 90%，非 CI 门槛；"摘要就绪"不等于"提交成功"，见 §7.2）；POL-09 可行性判定；H-SC-1 |
| **G3 智能切点** | 切点 100% 合法、**满足应用时的容量约束**、在容量允许内落在更高质量的语义边界、**保留尾部不少于原生** | CUT-01…08；W2 回放指标（附录 C） |
| **G4 信息保真** | 分层保障（§5.6 LED-08）：**结构化开放状态**（goal / flow run·task·gate / 后台任务）的身份与状态不丢；**用户指令**在预算内逐字、超出部分降级为"首 N 字符 + entryId 指针"且计数上报；**自然语言开放事项**无确定性保障（best-effort，由叙述承载）；已完成任务只留一行；**本控制器提交**的摘要永不为空/截断/局部缺失（对原生自己生成的摘要仅做事后审计，见 FB-08） | LED-01…08、SUM-04、E3/E6 夹具回归 |
| **G5 永远可回退** | 任何失败回到原生；`off` = 与未安装本模块**字节级行为一致** | FB-*、INV-1、H-SC-5/6 |
| **G6 零侵入兼容** | 不 patch pi；不破坏冻结面；goal/modes/memory 的压缩钩子在 draft 路径下**各触发恰好一次** | SM-*、契约套件、INV-* |

### 2.2 非目标（明确不做；做了即越界）

| # | 非目标 | 说明 |
|---|---|---|
| NG1 | **分块并行 map-reduce 摘要** | 用户决策：只要后台预压，不引入分块（复杂度）。"并行" = 预压与主对话并行 |
| NG2 | 多级/分层摘要 | 单摘要 + 台账，形态与原生一致 |
| NG3 | SoL-Pi 的 `update_plan` 触发与 cache 经济学（breakeven/debt） | 无 plan 的长任务会永不压缩；预压不作废主对话 cache |
| NG4 | 修改 pi、写 pi 的 settings/session 文件 | 只经 draft、`pi.appendEntry`、`session_before_compact` 返回值 |
| NG5 | 改 `pi-claude-code-tui` | TUI 已原生渲染 draft 压缩行（§4.1 H3）；预压状态的 TUI 呈现留后续 |
| NG6 | 修改 rex-flow 仓/协议、写 `~/.rex-flow` | 只读消费 board/dispatch 文件与对话内哨兵 |
| NG7 | planner / gatekeeper / worker 角色专属台账 | 只做 orchestrator 档；其他角色走通用台账 |
| NG8 | 压缩 `/compact <自定义指令>`、分支摘要（branch summary） | 保持原生 |
| NG9 | 经 bus 发布压缩状态 | 本期不碰 bus 快照；只有会话 entry + `/compaction status` |
| NG10 | 语义检索/向量召回 | 不属压缩范畴 |

### 2.3 边界（所有权与改动范围）

- **新增**：`extensions/compaction/**`、`lib/compaction-seam.ts`、`scripts/compaction-replay.mjs`、`test/lib/compaction-*.test.ts`、`test/contracts/compaction-*.test.ts`、`docs/{en,zh}/compaction.md`。
- **最小改动**（仅限本 spec 列出的点）：`extensions/index.ts`（装配一行）、`lib/context-budget.ts`（新增一个常量）、`scripts/run-tests.mjs`（注册 `nodeTestDirs`）、goal/modes/memory 各一个压缩钩子的**函数抽取 + seam 订阅**（W5）、`test/contracts/README.md`、`AGENTS.md`/`AGENTS.zh.md`/`CHANGELOG.md`/`DEVIATIONS.md`/`PROGRESS.md`/`docs/*/architecture.md`、`spec/README.md`。
- **禁止**：改 `extensions/observation-pack/**`、`extensions/bg-shell/**` 的行为；改 bus 快照形状；改任何既有 session entry 类型 / 磁盘布局；`lib/` 依赖 `extensions/`。

---

## 3. 不变量（违反即驳回）

| ID | 不变量 | 验收 |
|---|---|---|
| INV-1 | **永不阻塞回合**：所有 hook 体 try/catch；落盘路径只做同步内存运算与一次 draft 返回；任何异常 → 不返回 entries/`undefined` 并记遥测 | APP-06、FB-05；故障注入测试 |
| INV-2 | **无定时器/轮询**：后台工作 = 在事件 handler 内启动的单条 promise 链；无 `setInterval`/递归 `setTimeout`。唯一例外：FB-07 的 `fallbackDeadlineMs` **单次**超时（整个 fallback 只设一个），须在 settle 后清除 | 源码扫描测试（沿用 P1-EF-07 风格，白名单仅 fallback 的单次超时） |
| INV-3 | **thinking 所有权**：本模块不调用 `pi.setThinkingLevel`（摘要调用的 thinkingLevel 只作 `compact()` 参数） | 源码扫描（AGENTS 不变量 2） |
| INV-4 | **依赖方向**：`lib/` 不 import `extensions/`；`lib/compaction-seam.ts` 自包含 | 既有依赖方向扫描 + 新增覆盖 |
| INV-5 | **从不提交未通过校验或已陈旧的摘要**（范围：本控制器提议/供稿的结果；原生自己生成的摘要不在此列）；每个快照至多提交一次；**快照仅在"已确认提交"或"确认丢失"时消耗**，提议本身不消耗 | APP-02、APP-07、APP-08 |
| INV-6 | **只读 rex-flow**：不写 `~/.rex-flow`；不 import rex-flow 代码；board 读取 fail-open、≤ 2 MiB | LED-05 |
| INV-7 | **隐私**：遥测 entry 与日志**不含**摘要/台账正文，只含大小、id、原因码；回放工具只输出聚合；测试夹具必须是合成数据 | ST-01、W2 验收 |
| INV-8 | **预算**：台账 ≤ `COMPACTION_LEDGER_MAX`（12 000 字符），生产者自钳制（AGENTS 不变量 5） | LED-01 |
| INV-9 | **持久化块版本化**：摘要内台账块 `<cc-core-ledger v="1">…</cc-core-ledger>` 与 `details.ccCore.v` 带版本；未知版本忽略不报错 | LED-02b、契约 SC-SUM-01 |
| INV-10 | **冻结面**：新增 entry 类型/磁盘文件/环境变量先登记契约再写测试（AGENTS 不变量 6、7） | §8 |
| INV-11 | **不吞原生恢复**：任何 draft 提议不得发生在原生仍需对"最后一条 assistant 响应"做 length/overflow/错误恢复的边界上（H12） | POL-07、BLK-1 |
| INV-12 | **硬容量闸**：任何路径（draft / threshold·overflow 供稿）写入的压缩结果，其估算的下一次请求 token 必须 ≤ `hardFitRatio × T_n`（overflow 路径用更严的 `overflowFitRatio`）。宿主不替扩展做该校验（H13） | V8a、BLK-3 |
| INV-13 | **提交以宿主记录为准**：`entry_appended` 对扩展不可见（H3），"返回了 draft"不等于"压缩发生"；成功/订阅方 after 通知只能由"分支上出现带本提议 nonce 的 compaction 条目"触发 | APP-05、APP-08、BLK-2 |

---

## 4. 宿主事实与待验证项

### 4.1 已核实的宿主事实（pi 1.5.0，`node_modules/@earendil-works/pi-coding-agent/dist`）

每条在 W0 钉成契约测试（§8）；pi 升级使其变红 = 升级信号。

| ID | 事实 | 依据 |
|---|---|---|
| H1 | **`prepareCompaction`、`CompactionPreparation`、`estimateProjectedContextTokens`、`extractFileOps*` 不是公开导出**（包 `exports` 仅 `.` 与 `./rpc-entry`，不可深导入）。公开可用：`compact`、`generateSummary(WithUsage)`、`findCutPoint`、`findTurnStartIndex`、`estimateTokens`、`serializeConversation`、`shouldCompact`、`calculateContextTokens`、`getLastAssistantUsage`、`SettingsManager`、`buildSessionProjection`、`getLatestCompactionEntry`、类型 `CompactionSettings`/`FileOperations`/`CompactionResult` | `dist/index.d.ts:6,21,22`；`package.json` exports |
| H2 | `compact(preparation, model, apiKey, headers?, customInstructions?, signal?, thinkingLevel?, streamFn?, env?, retry?, callbacks?, sessionId?)` 接收一个**普通数据结构**的 preparation：`{firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary?, fileOps, settings}`，内部处理 split-turn 双摘要并追加文件操作清单 | `compaction.d.ts:118–144` |
| H3 | `turn_end`/`agent_before_settle` 返回 `{entries:[{type:"compaction", summary, firstKeptEntryId, details?, usage?}]}` → `_commitBoundaryDrafts` → `appendCompaction(..., fromHook=true)`（`tokensBefore` 由宿主按投影重估）→ `_refreshFinalizedContext()`（重建 `agent.state.messages`）→ 发 `entry_appended`；**不发** `session_compact` / `compaction_start\|end`。TUI 在 `entry_appended`+`compaction` 上自行重绘摘要行与成本提示；不 abort、不进入 `isCompacting`。**`entry_appended` 是宿主内部监听事件，不在扩展 `pi.on()` 事件集中（`extensions/types.d.ts` 无此事件）——扩展无法直接得知提交结果**；draft 的真实 entry id 在提交时才生成 | `agent-session.js:500–530,591–653`；`interactive-mode.js:2830–2860`；`types.d.ts`（无 entry_appended） |
| H4 | 下一回合的 context 由 `buildSessionProjection()` 重建（`_compactBeforeNextAssistantResponse` 与 `prepareRequest` 均如此），故 draft 落盘后下一次请求即使用新投影 | `agent-session.js:436–445,455–500,552–560` |
| H5 | `emitBoundary` 对多个 handler：事件携带累计的 `entries`；**handler 返回 `entries` 即整体替换**（最后一个返回者胜出）；所有 handler 跑完后才统一提交。因此：(a) 本模块必须 `[...event.entries, draft]`；(b) **排在我们之后的 handler 可以覆盖或追加**（含 `context_edit`），我们无法单方面保证 draft 必然提交，也无法预知同边界后续 draft | `runner.js:759–790` |
| H6 | `session_before_compact` 对多个 handler：**最后一个非空结果胜出**，仅 `cancel` 提前返回；返回 `{compaction}` → pi 跳过摘要 LLM，`appendCompaction(..., fromExtension=true)`，**照常发 `session_compact`**；事件含 `reason: "manual"\|"threshold"\|"overflow"`、`willRetry`、`signal`、`customInstructions` | `runner.js:805–830`；`agent-session.js:2286–2306,2561–2593` |
| H7 | `ctx.getContextUsage()` → `{tokens: number\|null, contextWindow, percent}`；**压缩后到下一次 assistant 响应前 `tokens` 为 null** | `types.d.ts:216`；`agent-session.js:3518–3540` |
| H8 | 有效压缩设置可经公开 `SettingsManager.create(cwd).getCompactionSettings(model)` 取得（`modelOverrides` 键 = `` `${model.provider}/${model.id}` ``）；`ExtensionContext` **不**暴露 settingsManager | `settings-manager.js:640–690` |
| H9 | `ctx.compact({customInstructions,onComplete,onError})` 是 fire-and-forget，走原生 `session.compact`（先 abort 在跑的 run） | `agent-session.js:2849` |
| H10 | 原生**不校验**摘要内容：E3 的空摘要被落盘（观察到，非源码断言；SUM-04 的夹具复现它）。注：pi 的 `getSummarizationFailure` 会对 `stopReason==="error"\|"length"` 抛错（所以截断/出错的摘要不会成功返回），但"stop + 空正文（reasoning-only）"不在其内 | 本地会话取证 E3；`compaction.js:getSummarizationFailure` |
| H11 | core 内已有压缩事件订阅方：goal（`session_before_compact` 记账；`session_compact`：persist + `beginAccounting` + 置 post-compact reminder + `queueContinuation`）、modes（`session_compact`：stats 失效、bypass 安全提醒、`persistState`）、memory（`session_before_compact`：`stageUnextractedTail`）。这些在 draft 路径下**不会**被 pi 触发（H3）。`session_before_compact` 在原生路径上本就可能**后续被 cancel/失败**（订阅方对"before 无 after"已有容忍义务） | `goal.ts:2012–2028`；`modes/index.ts:1660`；`memory/automation.ts:581`；`agent-session.js:2576–2588` |
| H12 | **截断/overflow 恢复依赖"最后一条 assistant 早于最新 compaction 时间戳"的判定**：`_checkCompaction` 在 run 结束后对最后一条 assistant 执行；若 `assistant.timestamp <= 最新 compaction.timestamp` 则**直接返回 false（跳过 overflow/length 恢复与 threshold）**。`turn_end.outcome` 把 `stopReason:"length"` 归为 `"completed"`（仅 aborted/error 被区分）；`isRecoverableLength` = `stopReason==="length"` 且输出 < 模型期望上限，此时原生做一次 compact-and-retry（`willRetry`）。因此在该 assistant 的 `turn_end` 提议 draft 会**吞掉恢复**。`agent_before_settle` 在 `_handlePostAgentRun`（含 `_checkCompaction`）之后触发 | `agent-session.js:501–503,1470–1485,1577,2428–2429,2455–2490`；`pi-ai/utils/overflow.js:177` |
| H13 | **宿主不校验扩展提供的压缩结果是否装得下**：`session_before_compact` 返回的 `compaction`（`summary/firstKeptEntryId/tokensBefore/usage/details`）被原样采用；boundary draft 同理。overflow 恢复只有**一次** compact-and-retry 机会（`_overflowRecoveryAttempted`） | `agent-session.js:2297,2463–2490,2576–2600` |
| H14 | **`compact()` 的可控面很窄**：无 `maxTokens` 参数（摘要沿用模型输出上限，#9512）；`thinkingLevel:"off"` 仅表示**不传** `reasoning` 参数（端点是否仍推理需实测，S3）；返回值（`CompactionResult`）**不含 stopReason**；split-turn 时内部发**两次**独立调用（历史摘要 + turn-prefix 摘要）并以固定分隔 `\n\n---\n\n**Turn Context (split turn):**\n\n` 合并——合并后无法从字符串反推各子摘要质量；各调用经可选 `streamFn(model, context, options)` 参数发出（`.result()` 返回 `AssistantMessage`，含 `stopReason`/`content`/`usage`），**这是唯一的逐调用观测与参数注入点**（含 `retryAssistantCall` 的瞬时重试，同一逻辑调用可能多次进入 `streamFn`）。历史摘要提示以 `<conversation>` 开头、turn-prefix 提示以 `# Conversation` 开头（pi 内部文案，须契约钉住） | `compaction.js:442–560,686–735` |
| H15 | **`context_edit` 只作用于投影内的条目**：`buildSessionProjection` 按 `targetId` 取编辑应用到**当前投影内**的条目；压缩点之前的条目不在投影内，针对它们的 `context_edit` **无效果**——旧内容已进入摘要后再被"删除"，摘要仍保留它。core 内**无**模块产生 `context_edit`（grep 为空）；扩展外的 handler 可以 | `session-manager.js:201–260`；`grep context_edit extensions lib` |
| H16 | **真实宿主脚手架可行（2026-11-09 一次性冒烟已验证，脚本未入库）**：进程内用**真实 `AgentSession`**——`fauxProvider()`（`@earendil-works/pi-ai` 根导出）+ `ModelRuntime.create({authPath, modelsPath:null, refreshOnCreate:false})`（`pi-coding-agent` 公开导出）+ `runtime.registerNativeProvider(faux.provider)` + `createAgentSession({cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(), resourceLoader: <stub>})` + `session.bindExtensions({})`；被测扩展经**仅测试可用**的深导入 `loadExtensionFromFactory`/`createExtensionRuntime` 装入（先例：`extensions/effort/tests/integration.test.ts`）。**注意**：① `compat.registerFauxProvider` **不适用**（ModelRuntime 报 "no API implementation"，须用 `fauxProvider` + `registerNativeProvider`）；② `session.prompt` 遇 provider 错误**不抛异常**（只落 `stopReason:"error"`），测试必须断言 stopReason 与 `faux.state.callCount`；③ faux 响应可为工厂函数（可抓取每次请求的 context），`fauxAssistantMessage(..., {stopReason})` 可构造 `length`/`toolUse`，`fauxToolCall` + `pi.registerTool` 可构造工具回合 | 冒烟（§4.4 末）；`pi-ai/dist/providers/faux.d.ts`；`model-runtime.d.ts` |

### 4.2 旧草案否决 draft 路线的理由，及本 spec 的回应

| 旧理由 | 回应 |
|---|---|
| 接管后需自管 overflow recovery（`willRetry` + `agent.continue()`） | **不自管**：overflow/threshold/manual 仍由原生发起，本模块只在 `session_before_compact` 里"供稿"（FB-*）；draft 只用于**提前于阈值**的常规压缩 |
| draft 路径的 TUI 压缩行"未证实" | H3：`interactive-mode.js:2830–2860` 已专门处理 `entry_appended`+`compaction`（含 `entriesRenderedByBoundaryCompaction` 去重与成本提示）。端到端仍由 S1/H-SC-1 复核 |
| 压缩队列 flush 等状态要自管 | draft 路径不进入 compacting 状态，无排队需求；原生路径未改动 |
| 接管后无兜底 | 原生始终开启作守门员（用户 `compaction.enabled=false` 时控制器降为 shadow，POL-06） |

### 4.3 待验证项（W0 必须产出结论；结论回填本表，并据此冻结 W3/W5 的实现）

| ID | 验证内容 | 通过判据 | 不通过时的决策（已预先批准，不需再问） |
|---|---|---|---|
| **S1** | `turn_end` / `agent_before_settle` 返回 compaction draft 的端到端行为。**主证据用真实 `AgentSession`（`createAgentSession`）+ faux provider 在进程内取得（H16，可进契约套件）；PTY 仅补 TUI 渲染项③** | ① jsonl 出现 `compaction` 条目（`fromHook:true`）；② 同一 run 的**下一次 provider 请求**上下文已缩小；③ TUI 显示摘要行 + 成本提示且无 spinner（PTY）；④ 无 `session_compact`/`compaction_start\|end`；⑤ 排队中的 steer/follow-up 不丢；⑥ `/resume` 后投影正确；**⑦ 记录"draft 提交后第一个对扩展可见的事件"是哪一个（`turn_start`/`context`/`before_provider_request`/`agent_end`/`agent_settled`…），作为 APP-08 对账触发集的依据** | turn_end 不通过 → **只在 `agent_before_settle` 落盘**（apply 点收窄为 run 结束，POL-07 同步调整）；两者皆不通过 → 落盘改为 `ctx.compact()`+`session_before_compact` 供稿（无 LLM，run 空闲时立即完成），常规压缩降为"run 间落盘"，G1 文字改述并记 DEVIATIONS |
| **S2** | 手工构造的 `CompactionPreparation` 喂给公开 `compact()` 与 pi 内部 `prepareCompaction` 产出**等价**（H1/H2） | 差分测试：同一 entries+settings，在受控 `keepRecentTokens` 下使内部 cut == 我们的 cut；`messagesToSummarize`/`turnPrefixMessages`/`isSplitTurn`/`firstKeptEntryId`/`previousSummary`/`fileOps` 逐项相等（差分 oracle 允许**仅测试代码**按文件路径导入 dist 内部模块；生产代码禁止） | 不等价 → 以 pi 内部行为为准修 builder；`compact()` 拒绝手工结构 → 改为只用 `generateSummaryWithUsage` 并自行拼装 split-turn（范围变大，须回报用户） |
| **S3** | 复现 E3（reasoning-only 空摘要）；验证 (a) `compact(..., thinkingLevel:"off")` 在 CPA/GLM/MiniMax/OpenAI 兼容端点上是否真的不再推理（H14：它只是省略 `reasoning` 参数）；(b) **经 `streamFn` 包装器能否在 `options` 上注入 `maxTokens`（及按供应商关闭推理的参数）并被端点遵守** | 复现夹具入库（合成）；关 thinking / 注入限额后输出为正文且不被截断 | 某模型无法关 thinking → `summaryThinking` 默认改 `minimal`；注入不可行 → `maxTokens` 视为不可控，校验闸（SUM-04，逐子调用）是唯一防线并在 `/compaction status` 注明 |
| **S4** | `SettingsManager.create(cwd)` 在扩展内可用，且 `getCompactionSettings(model)` 与 pi 自身一致（含 modelOverrides、project 级 settings） | 单测：对用户真实形态的 settings（`modelOverrides` 里 `provider/id` 含 `/`）与 pi 实际阈值一致 | 若创建有副作用（写文件/锁）→ 改为只读解析 `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json`（`lib/settings.ts` 的 `readJson`）并复刻 override 解析，差分测试对拍 |
| **S5** | 审计 goal/modes/memory/recall 的压缩钩子在 draft 路径下的正确行为，产出**逐订阅方行为表**（`before`/`after` 各做什么、`midRun` 时哪些必须跳过、**"before 之后提议丢失（无 after）"时是否有残留副作用**，尤其 goal 的 `queueContinuation` 与 post-compact reminder 的消费点） | 行为表入本 spec；无"双触发 / 漏触发"；"before 无 after"路径无不可逆副作用 | 无（W5 的实现直接以此表为准；表与 §5.9 默认值冲突时以表为准并更新 §5.9） |

#### §4.3 结论回填（W0，2026-11-09；全部在 pi 1.5.0 真实 `AgentSession` + faux provider 或公开纯函数上取得，自动化固化于 `test/contracts/compaction-*.test.ts` 与 `test/spikes/compaction-*`）

| ID | 结论 | 证据去向 | 触发的降级路径 |
|---|---|---|---|
| **S1** | **通过（turn_end 与 agent_before_settle 均可落盘）**。①分支出现 `compaction` 条目（`fromHook:true`、`tokensBefore` 由宿主按投影重估——draft 不携带该字段）；②同一 run 下一次 provider 请求上下文缩为 `system, user(=摘要), assistant, toolResult`，工具调用/结果配对未切开；④无 `session_before_compact`/`session_compact`，且 `entry_appended`/`compaction_start\|end` 不在扩展事件集中（类型级钉住）；⑤排队中的 steer 与 followUp 均不丢（steer 进入提交后首次请求；followUp 在 settle 边界作为 continuation 消费或落为独立 user 条目，精确交错属宿主队列机制、非本契约）；⑥`/resume` 投影：以分支条目重建的新 `SessionManager` 投影正确（`system, compactionSummary, …`）；⑦**draft 提交后第一个对扩展可见的事件：run 末提交 = `agent_end`（随后 `agent_before_settle`、`agent_settled`），回合中途提交 = `turn_start`**——均在 §5.2 默认对账触发集内，触发集无需调整 | `compaction-boundary.test.ts`（SC-HOST-02/03/10）；`compaction-recovery`（部分） | **无**——预批的"仅 agent_before_settle"与"ctx.compact 改造"两条降级路径均未触发；`turn_end` 作为 apply 点成立（仍受 POL-07 安全条件约束） |
| **S1 附属差异（对 §4.4 冒烟记录的修正）** | 一次性冒烟脚本未订阅 `agent_end`，故记"run 末提交后第一个可见事件 = agent_settled"；W0 全事件探针实测为 **`agent_end`**。不改变任何需求（§5.2 触发集已含 `agent_end`），仅修正观察 | `compaction-boundary.test.ts` 文件头注释 + 本行 | — |
| **S2** | **通过**。公开件（`buildSessionProjection` + `findCutPoint`）构造的 hand preparation 与 dist 内部 `prepareCompaction` oracle 在 `firstKeptEntryId`/`isSplitTurn`/`messagesToSummarize`/`turnPrefixMessages` 上**逐项相等**；`compact()` 接受手工结构（split 时两次子调用）。`previousSummary`/`fileOps` 的差分需要"带前次压缩 + 文件工具调用"夹具与 fileOps 提取复刻，归 W3 的 SUM-01/02 差分测试所有（本夹具两者皆空、天然相等） | `compaction-summarizer.test.ts`（SC-HOST-05）；spike `compaction-summarizer-smoke.ts` | **无**（`compact()` 未拒绝手工结构，未触发范围扩大） |
| **S3** | **夹具复现通过；注入力学通过；真实端点合规 = 待证据项**。E3 在两层复现：宿主层（原生阈值压缩 + reasoning-only 摘要响应 → 落盘仅剩固定分隔样板，BLK-5 基线）与纯函数层（BLK-4 矩阵）。(a) `thinkingLevel:"off"` 时 `options` 不含 `reasoning` 键（faux 实测；端点是否仍自行推理待真机）；(b) streamFn 包装器在 `options` 注入 `maxTokens` 类型合法（pi-ai `StreamOptions.maxTokens`）且委托方可见——**注入点成立，端点遵守与否待真机**。待证据恢复条件：W9 在 CPA/GLM/MiniMax/OpenAI 兼容端点各跑一次受控摘要（关 thinking / 注入限额 → 输出为正文且不截断）；不可行则按 §4.3 S3 预批处理（`summaryThinking` 改 `minimal` / `maxTokens` 视为不可控） | `compaction-native.test.ts`（H10 基线）；`compaction-summarizer.test.ts`（S3 力学）；`compaction-summarizer-smoke.ts` | 部分（见"待证据项"） |
| **S4** | **通过**。`SettingsManager.create(cwd, agentDir)` 仅读（创建与 getCompactionSettings 不落任何文件）；`modelOverrides` 键 = `provider/id`（含斜杠），解析序 override > ordinary > 内建默认（16384/20000）；与 pi 自身阈值一致：`shouldCompact(tokens, window, settings)` 边界恰为 `window − 有效 reserveTokens`。无需切换到只读解析复刻方案 | `compaction-support.test.ts`（SC-HOST-06） | **无** |
| **S5** | **行为表已产出**（回填 §5.9）。要点：draft 路径下三订阅方现有 pi 钩子均不触发（H3/H11 成立，契约钉住）；goal 的 after 动作含三个"before 无 after 时不可取"的副作用（`beginAccounting` 时钟段重置、post-compact reminder 误武装、`queueContinuation` 多余续跑）——W5 seam 必须仅在 committed 后通知 after，且 `midRun` 跳过 `queueContinuation`（SM-03）；memory 的 before（staging）对"before 无 after"幂等无害（同 sessionId 队列合并 + shutdown 兜底再 staging）；modes 的 after 全幂等 | §5.9 表 + `compaction-boundary.test.ts`（draft 路径无 session_compact 事件） | **无** |

**夹具层新发现的宿主事实（W0，供 W3/W4 写测试时引用）**：

1. **会话质量必须超过 `keepRecentTokens`**：`prepareCompaction` 在总内容不足时返回 `undefined`，发生在**任何事件/落盘之前**（`_runAutoCompaction` 在 emit `compaction_start` 前就 return false）——压缩类夹具若太小会"静默无事发生"，与被测行为无关。
2. **合成 usage 必须带 `cost` 对象**：split-turn 合并调 `combineUsage`，其直接解引用 `usage.cost.input`——缺 `cost` 的合成 usage 会让 `compact()` 抛 `TypeError`（宿主未做防御）。
3. **`retryAssistantCall` 只重试"响应"不重试"异常"**：包装器要以 stopReason:"error" + retryable errorMessage 的 AssistantMessage **返回**模拟瞬时失败；抛出的异常直接穿透。
4. **供稿路径的 entry 字段名是 `fromHook`**（`session_compact` 事件上才是 `fromExtension`）：`appendCompaction(..., fromHook)` 的第 5 参在 `_runAutoCompaction` 里传的是 fromExtension 值。
5. **宿主接受不存在的 `firstKeptEntryId`**（供稿与 draft 均照单全收，投影退化为"仅摘要"）——BLK-3 家族的又一形态，V3 的合法性校验因此必要。

### 4.4 阻断性用例（W0 必须交付；**任何一条红 → 冻结 W3/W4/W5 不得开工，且不得 `test.todo` 豁免**；若某条在 pi 1.5.0 下不可构造，须回报用户而非降级）

全部在进程内用真实 `AgentSession` + faux provider + 真实 `SessionManager` 实现（H16），放 `test/contracts/compaction-*.test.ts`。每条同时包含"**无保护基线**"（证明风险真实存在，宿主确实如此）与"**有保护断言**"（证明本 spec 的规则能挡住）。W0 先做基线，因为基线即对宿主事实的钉住。

| ID | 场景 | 基线（无保护，钉住宿主行为） | 保护断言 | 约束的需求 |
|---|---|---|---|---|
| BLK-1 | **截断恢复**：最后一条 assistant `stopReason:"length"` 且 `usage.output < model.maxTokens`（可恢复截断） | 在其 `turn_end` 插入 compaction draft → 原生 `_checkCompaction` 因时间戳判旧而**不再**重试；不插则重试 | 按 POL-07 规则（排除 length/error/aborted 及"待原生恢复"）：控制器在该边界**不提议**；原生恢复照常发生；且该次恢复之后控制器仍可正常工作 | POL-07、INV-11 |
| BLK-2 | **提交协议**：(a) 我们的 draft 之后，另一个 `turn_end` handler **整体覆盖** `entries`；(b) 另一个 handler 在同边界**追加** `context_edit` 指向被压区条目；(c) 正常提交 | (a) 分支无 compaction 条目；(b) 被压区条目的编辑无效果但旧内容已在我们的摘要里（H15） | (a) 对账判定 `lost(overridden)`，快照不消耗、不触发 seam after；(b) 对账判定 `conflict-edit` 并计数；(c) 对账在 S1⑦ 确定的第一个事件上命中 nonce，seam after **恰好一次**；全程 `before` 与 `after` 解耦 | APP-04/05/08、V4/V10、SM-02 |
| BLK-3 | **过大的旧快照**：快照后继续增长，使"摘要 + 现尾部"超过窗口（如 32K 窗口、投影估算约 50K） | 经 `session_before_compact` 返回或经 draft 提交，宿主均**照单全收** | V8a 拒绝；fallback 腿改走同步重新生成（带 deadline）或返回 `undefined`；overflow 路径使用更严的 `overflowFitRatio` | V8a、FB-01/02、INV-12 |
| BLK-4 | **split-turn 局部空摘要**：脚本化 `streamFn`——历史摘要正常、turn-prefix 摘要仅 reasoning（空正文）；以及反向；以及两者都正常；以及瞬时失败触发 `retryAssistantCall` 重试 | 合并后的字符串仍满足"总长/标题数/reasoning 占比"的**整体**校验（评审复现：788 字符、2 标题、占比 50%） | 逐子调用校验拒绝局部空摘要；重试不会把同一逻辑调用重复计数或错判；两者正常则通过；最终装配结果再校验一次 | SUM-03/04/09 |
| BLK-5 | **原生摘要事后审计**：原生路径（我们返回 `undefined`）产出空摘要 | 宿主照常落盘（H10） | `session_compact`（`fromExtension:false`）上审计命中 → 遥测 `native-summary-invalid` + 一次 `notify`；**不**宣称"空摘要永不落盘"覆盖原生 | FB-08、G4 范围 |

**冒烟证据（2026-11-09，真实 `AgentSession` + faux provider，一次性脚本、未入库；W0 须把它们固化为契约/阻断性测试）**

| 场景 | 观察 | 对应 |
|---|---|---|
| S1：run 末回合 `turn_end` 返回 compaction draft（`stop`） | jsonl 出现 1 条 `compaction`（`fromHook:true`）；**无** `session_before_compact`/`session_compact`；投影变为 `system, compactionSummary, assistant`；提交后第一个可见事件 = `agent_settled`（**W0 修正：全事件探针下实为 `agent_end`，见 §4.3 结论表附行**） | S1①④、H3 |
| S1（回合中途）：工具回合 `turn_end`（`toolUse`）返回 draft | 同一 run 的**下一次 provider 请求**上下文由 12 条缩到 4 条（`user(=摘要), assistant, toolResult` + system）；工具调用/结果配对未被切开；提交后第一个可见事件 = `turn_start` | S1②⑦、H4、§5.2 对账触发集 |
| BLK-1 基线：`stopReason:"length"`（可恢复）、**无** draft | `turn_end.outcome=completed`；原生触发 `session_before_compact(reason:"overflow", willRetry:true)` → `session_compact` → 重试回合；provider 调用 3 次 | H12 |
| BLK-1 hazard：同上但 `turn_end` 返回 draft | **原生恢复被吞**：无 `session_before_compact`、无重试，provider 调用 1 次，最终助手消息停在被截断的 `length` | H12、POL-07、INV-11 |
| BLK-2(a)：后序 handler 返回 `entries: []` | 我们的 draft **悄无声息地丢失**（分支无 compaction；之后只见 `agent_settled`，无任何通知） | H5(b)、APP-08 对账 |
| BLK-2(b)：后序 handler 追加 `context_edit`（targetId=被压区条目，`replacement:null`） | compaction 照常提交；该编辑对投影**无效果**（投影仍为 `system, compactionSummary, assistant`），被编辑内容已在摘要里 | H15、V4'/APP-08 |

未覆盖、留给 W0：`agent_before_settle` 落盘、steer/follow-up 排队不丢、`/resume`、PTY 下 TUI 摘要行、BLK-3（小窗口过大旧快照）、BLK-4（逐子调用校验）、BLK-5。

**W0 落地记录（2026-11-09）**：BLK-1…5 **全部在 pi 1.5.0 下可构造**，基线与保护断言已固化——基线（宿主行为钉住，绿）在 `test/contracts/compaction-{boundary,native,recovery,summarizer}.test.ts`；保护断言（W3/W4 实现后转绿）以 `it.fails` 钉在 `test/contracts/compaction-protection.test.ts`（7 条，BLK-2 拆 a/b/c）。上表冒烟结果全部复现一致，唯一修正见 §4.3 附行（run 末提交后第一个可见事件 = `agent_end` 而非 `agent_settled`，系冒烟探针未订阅该事件）。留 W0 之外的仅剩：PTY 下 TUI 摘要行与无 spinner（③，W9 真机）与磁盘 jsonl 序列化（W0 用 `SessionManager.inMemory` 证明 appendCompaction/投影路径；同一 appendCompaction 代码负责落盘，真机 jsonl 由 W9 复核）。

---

## 5. 设计与可验收需求

### 5.1 模块布局与文件所有权

```
extensions/compaction/
  index.ts           # factory + 事件装配（turn_end / agent_before_settle / session_before_compact /
                     #   session_start / session_tree / session_shutdown）+ /compaction 命令
  types.ts           # 跨文件共享类型（W1 首先落地，其余任务依赖它）
  policy.ts          # 纯函数：压力采样 → 动作
  cutpoint.ts        # 纯函数：候选边界打分与选择（含 split-turn 判定）
  signals/
    generic.ts       # user / plain-turn / tool-turn / idle-gap            （W1）
    long-task.ts     # goal-step / git-commit / verified                   （W8）
    rex-flow.ts      # run-closed（哨兵 + board 语义）                      （W7）
  preparation.ts     # 构造 CompactionPreparation + 文件操作提取（H1）      （W3）
  summarizer.ts      # 后台单飞摘要任务 + 中止 + 重试                        （W3）
  validate.ts        # 摘要校验闸                                           （W1）
  apply.ts           # 前置校验 V1–V10 + 提议 draft + 提交对账（proposed→committed/lost）（W3）
  fallback.ts        # session_before_compact 供稿腿                        （W4）
  state.ts           # 状态机、闩锁、遥测 entry                              （W3/W4）
  settings.ts        # core-compaction.json + env                          （W1）
  ledger/
    types.ts / assemble.ts / goal.ts / directives.ts / files.ts / verification.ts / bg.ts   （W6）
    rex-flow.ts                                                                          （W7）
lib/compaction-seam.ts   # before/after 订阅点，按 entryId 去重                            （W5）
```

### 5.2 状态机（每会话一份，内存态；遥测见 §5.10）

```
idle ──(P ≥ preRatio, 事件边界, 未在冷却, POL-09 可行)──► computing
computing ──(逐子调用校验 + 装配后校验均通过)──► ready
computing ──(失败/校验不过，已重试 1 次)──► refused(冷却 N 回合) ──► idle
ready ──(apply 点 + P ≥ applyRatio + 前置校验 V1–V10 全过，返回 draft)──► proposed{proposalId}
proposed ──(对账：分支上出现带 proposalId 的最新 compaction 条目)──► committed ──► idle      [seam after、遥测 applied]
proposed ──(对账：未出现——被后续 handler 覆盖/丢弃/分支变化)──► lost(原因码) ──► idle        [快照作废、遥测 discarded]
ready ──(前置校验失败 / session_tree / 窗口变化 / 快照过大)──► discarded(原因码) ──► idle
任意 ──(session_shutdown / session_start)──► 中止在途任务并重置（generation++，晚到结果一律丢弃）
```

**对账（reconcile）**：`entry_appended` 对扩展不可见（H3），因此在 draft 返回后的**第一个对扩展可见的事件**上（触发集由 S1⑦ 确定，默认 `turn_start`/`context`/`before_provider_request`/`agent_end`/`agent_before_settle`/`agent_settled`/`input`/`session_before_compact`/`session_tree`/`session_shutdown` 的并集，取最先到达者）同步扫描 `ctx.sessionManager.getBranch()` 自叶向前至多 `reconcileScanMax`（默认 50）条：命中 `type==="compaction"` 且 `details.ccCore.proposalId` 相等 → committed；扫描范围内无命中 → lost。committed 时附加审计（V4'：见 APP-08）。**冒烟观察（§4.4；W0 修正：run 末首个可见事件实为 `agent_end`，见 §4.3 附行）**：回合中途提交后第一个可见事件是 `turn_start`，run 末回合提交后是 `agent_settled`（冒烟探针未订阅 `agent_end`），二者都在默认触发集内；后序 handler 覆盖 draft 时**没有任何事件告知**（BLK-2(a)），对账是唯一的发现途径。

不变量：单飞（同一会话至多一个 computing）；`ready` 快照在 `proposed` 期间保持不可再提议，**仅在 committed/lost 时消耗**（INV-5）；discarded/lost 后至少隔 `minPrecomputeGapTurns` 个回合才可再次 computing；`generation` 计数使任何旧任务的晚到完成/对账结果被忽略（FB-07）。

### 5.3 压力策略（`policy.ts`）

`T_n = contextWindow − effectiveReserveTokens`（与原生同源，H8）；`P = tokens / T_n`。

| ID | 要求 | 验收 |
|---|---|---|
| POL-01 | `T_n` 取自**有效**设置（含 modelOverrides）；`T_n ≤ 0` 或任一输入缺失 → 控制器保持 idle，**不抛** | 单测：含 `provider/id` 含斜杠的 override；`reserve ≥ window` |
| POL-02 | 配置比例须满足 `0 < targetPostRatio < preRatio < applyRatio < 1` 且 `0 < hardFitRatio ≤ 1`、`overflowFitRatio ≤ hardFitRatio`，违反 → 整组回退默认并产出一条 warn（不抛） | 单测 |
| POL-03 | 决策为**纯函数**：`(state, P, readiness, event) → action`；表驱动测试覆盖状态机每条边（含冷却、单飞、discarded/lost 间隔、proposed 期间不可再提议） | 单测：状态×事件矩阵 |
| POL-04 | `tokens === null`（H7）→ 不推进状态、不触发 | 单测 |
| POL-05 | 仅在 `turn_end` / `agent_before_settle`（及 `session_before_compact` 供稿、对账触发集）评估；无定时器（INV-2） | 源码扫描 |
| POL-06 | 用户设置 `compaction.enabled=false` → 模式强制降为 `shadow` 并在 `/compaction status` 注明；不得自动压缩 | 单测 + H-SC-5 |
| POL-07 | **apply 点与安全条件（INV-11，H12）**：apply 点集合 = {`turn_end`, `agent_before_settle`}（S1 判 turn_end 不通过则仅后者）。**`outcome==="completed"` 不是充分条件**。每个 apply 点还必须全部满足：① 被评估的最后一条 assistant 的 `stopReason ∈ {"stop","toolUse"}`——**排除 `"length"`（无论是否可恢复，保守）、`"error"`、`"aborted"`**；② 本 run 当前没有待处理的原生恢复（`_failedResponse`/重试窗口：以 `turn_end.outcome`、`stopReason` 与"同一 run 内刚发生过 overflow 恢复"的会话内标志判定——该标志在 `session_before_compact`(`reason:"overflow"`)/`session_compact_failed` 上置位，下一个 `agent_settled` 清除）；③ `agent_before_settle` 处同样检查最后一条 assistant 的 stopReason 与 outcome（`_checkCompaction` 已先于它运行，但恢复失败时最后一条仍可能是 length/error，此时不提议） | 单测（stopReason×outcome×恢复标志矩阵）+ **BLK-1**（真实宿主：不吞恢复，且恢复后控制器照常工作） |
| POL-08 | pi 版本 < `1.5.0`（或 `pi-compat` 探测失败）→ 模式强制 `off` + 一条 warn，不阻塞会话 | 单测（沿用 economy 模块的降级写法） |
| POL-09 | **联合可行性（阈值、尾部预算、V8 联合求解）**：令 `T=T_n`，`p=preRatio`，`a=applyRatio`，`q=targetPostRatio`，`S=summaryTokenEstimate`（默认 12 000 tokens；若已有上次摘要则取 `max(默认, 1.2×上次摘要 token)`），`G(P_s)=max(0, a−P_s)·T`（快照时 `P_s` 到应用阈值之间预期还会增长的量），`keep=keepRecentTokens`。**可行条件**：`keep + S + G(P_s) ≤ q·T`。不可行 → 状态 `infeasible-window`：控制器**不预压**（原生照常工作），`/compaction status` 显示原因与"需要 T_n ≥ …"，遥测一次（每会话一次，不刷屏）。默认参数下 `T_n ≳ (keep+S)/(q+p−a)`≈ 107K | 单测：默认参数下 T_n=40K → infeasible、T_n=200K → feasible；边界值；`S` 随上次摘要自适应 |
| POL-10 | **估算口径**（供 V8a/V8b/POL-09）：`estimatePost(summary, keptEntries)` = 摘要 token（经 `estimateTokens` 对合成 `compactionSummary` 消息）+ 保留尾部各消息 token（`estimateTokens`，基于**应用 `context_edit` 后的投影**）+ `overhead`；`overhead = clamp(ctxTokens_usage − estimateMessages(currentProjection), 0, 0.3·contextWindow)`（`ctx.getContextUsage().tokens` 可用时校准系统提示/工具定义占用，否则取 `unknownOverheadTokens` 保守默认）。估算偏差由 `hardFitRatio`（默认 0.9）的安全边际吸收，且遥测记录"估算 vs 下一次真实 usage"的偏差供 W2 校准 | 单测（含 context_edit 夹具；overhead 校准；null usage 路径） |

### 5.4 切点（`cutpoint.ts` + `signals/*`）

输入：投影后的条目序列（`buildSessionProjection().entries`，每项含 `sourceEntry` 与 `messages`）、上一次压缩的位置、有效 `keepRecentTokens`、设置。输出：`{firstKeptEntryId, isSplitTurn, turnStartIndex, tailTokens, class, score}`。

**合法切点**：投影条目的首条消息角色 ∉ {`toolResult`}；不是上一次压缩条目本身；位置在上一次压缩的 `firstKept` 之后。（与原生 `isCutPointMessage` 等价，禁止切在 toolResult。）

**搜索窗口（容量优先，再评语义）**：先由 POL-09 求出**容量上界** `tailMax = q·T − S − G(P_s)`（`q` 即 `targetPostRatio`），候选尾部必须落在 `[keepRecentTokens, min(keepRecentTokens + keepSlackTokens, tailMax)]`；窗口为空（`tailMax < keep`）即不可行（POL-09），**不得**为追求语义分而放宽到容量之外。**尾部永不少于原生**（只会多留，不会少留）。语义评分只在满足容量约束的候选之间进行。

**边界类（权重默认值见附录 C）**：`run-closed` > `goal-step` > `user` > `git-commit` > `verified` > `idle-gap` > `plain-turn` > `tool-turn`。信号表示"边界在该条目**之后**"，候选切点 = 该边界后第一个合法切点。`score = 类权重 − λ·|尾部 − 原生尾部|/slack`。

| ID | 要求 | 验收 |
|---|---|---|
| CUT-01 | **合法性**：对随机生成的会话（带种子，覆盖 toolCall/toolResult 交错、连续 assistant、旧压缩条目、`custom`/`branch_summary` 条目），输出永不落在 toolResult、永不早于上次压缩边界 | 种子化属性测试（≥ 2000 例），失败打印种子 |
| CUT-02 | **尾部下界**：`tailTokens ≥ keepRecentTokens`；窗口内无候选时退化为原生等价切点（并标记 `class:"native-equivalent"`） | 单测 + 对拍 |
| CUT-03 | **偏好**：窗口内存在更高类候选 → 选最高分；同分取最接近原生尾部者；全过程**确定性**（同输入同输出） | 单测（构造多候选夹具） |
| CUT-04 | **orchestrator**：夹具中 `run-closed` 边界落在窗口内 → 必选之；其后第一个合法切点；`run-closed` 的识别规则见 LED-05 | 合成 rex-flow 夹具 |
| CUT-05 | **无 user 边界的长任务**：单一巨型回合（几乎全是 assistant/tool 交错）下仍能产出合法切点；`isSplitTurn` 与 `turnStartIndex` 与原生语义一致，由 `compact()` 处理双摘要 | 夹具：4 条 user / 数千条 assistant+tool |
| CUT-06 | **性能**：1 万条目夹具上 `selectCut` ≤ 1s（宽松上界，防回归；实测值写进测试输出） | 单测 |
| CUT-07 | `signals/*` 通过统一接口注册（`(entry, ctx) => weight\|0`）；任一 signal 抛错 → 该 signal 视为 0，不影响其他 | 单测 |
| CUT-08 | **容量优先**：对任意输入，若存在满足 `tailMax` 的合法候选，则输出必满足 `tail ≤ tailMax`；高语义分但超容量的候选一律不选；窗口为空时返回 `infeasible`（不抛、不回退到超容量切点）。含小窗口夹具（T_n=40K 默认参数 → infeasible；放宽 keep 后 → 选出满足约束的切点） | 单测 + 种子化属性测试（≥ 2000 例，断言 `tail ≤ tailMax` 与 CUT-01/02） |

### 5.5 摘要生成与校验（`preparation.ts` / `summarizer.ts` / `validate.ts`）

| ID | 要求 | 验收 |
|---|---|---|
| SUM-01 | `buildPreparation(cut, …)` 产出与 pi 内部 `prepareCompaction` **等价**的结构（H2）；**`messagesToSummarize`/`turnPrefixMessages` 必须取自应用 `context_edit` 后的投影**（H15：编辑已删除/替换的内容不得进入摘要输入）；`previousSummary` = 上次压缩摘要**去掉台账块后的叙述部分** | S2 差分测试（oracle 仅测试可导入 dist 内部；**fixture 含 `context_edit` 条目**） |
| SUM-02 | 文件操作提取（read/write/edit 工具调用 → `readFiles`/`modifiedFiles`）与 pi 的 `extractFileOpsFromMessage`+`computeFileLists` 对同一消息序列输出一致 | 差分测试 |
| SUM-03 | **受控调用**：摘要一律经 `compact(..., streamFn)` 发出，`streamFn` 为本模块的**观测/注入包装器**（H14）：① 记录每个逻辑调用的 `AssistantMessage`（`stopReason`/`content`/`usage`）；② 在 `options` 上按 S3 结论注入 `maxTokens` 与（可行时）关闭推理的参数，`thinkingLevel` 取配置（默认 `off`）；③ 不改变 pi 的重试语义（包装器对 `retryAssistantCall` 的重复进入幂等：同一逻辑调用只保留**最后一次**结果）；④ 单飞；usage 合并后写入 draft 的 `usage` | 单测（脚本化 streamFn，含瞬时失败重试）+ S3 |
| SUM-04 | **校验闸**（`validate.ts`，纯函数）分**逐子调用**与**装配后**两层，全部通过才可能提议/供稿：**逐子调用**（历史摘要、turn-prefix 摘要各自独立）：① `stopReason` 非 `length/error/aborted`（pi 已对 length/error 抛错，此处作防御）；② 叙述正文长度 ≥ 该调用类型的下限（历史 `minNarrativeChars`，turn-prefix `minPrefixChars`）；③ reasoning-only 判定（`usage.reasoning ≥ 0.9·usage.output` 且正文 < 下限，或正文为空）；④ 无 toolCall。**装配后**：⑤ 去掉 `<read-files>`/`<modified-files>` 后叙述 ≥ `minNarrativeChars` 且至少 2 个 markdown 标题（语言无关）；⑥ 总长 ≤ `maxSummaryChars`；⑦ 非空且不是纯文件清单；⑧ **split-turn 时**必须含 turn-prefix 分隔段且该段正文 ≥ `minPrefixChars`；⑨ 调用数与预期一致（预期 = `messagesToSummarize` 非空 ? 1 : 0 + split ? 1 : 0，按 SUM-09 分类计数，不计重试） | 单测矩阵：空 / **E3 夹具（仅文件清单，970 字符形态）** / 截断 / reasoning-only / 超长 / 正常 / **split-turn：历史正常+前缀空、前缀正常+历史空、双正常**（**BLK-4**） |
| SUM-05 | 校验失败 → 重试**一次**（换参数：更强的"必须输出完整摘要"指令、thinking 关闭）；仍失败 → `refused`，冷却 `refusedCooldownTurns` 回合；累计 `degradeAfterRefusals` 次 → 本会话降为 `shadow` + 一次 notify | 单测（stub 摘要器） |
| SUM-06 | `summaryModel` 可配（`"provider/id"` 或 null=会话模型）；解析方式同 `extensions/memory/llm.ts`（`modelRegistry` + `getApiKeyAndHeaders`）；若其 `contextWindow` < 预估输入×1.1+输出预留 → 跳过并用会话模型（遥测记 `summaryModelFallback`）；**不分块** | 单测 |
| SUM-07 | 中止：`session_shutdown` / `session_tree` / 会话切换 / 重置 → `AbortController.abort()` 且 `generation++`；中止后晚到的完成结果**丢弃**且不产生 unhandled rejection；单飞锁随 `generation` 释放（不等待旧调用真正结束）。**同一规则适用于 fallback 的 deadline 超时**（FB-07） | 单测（延迟 stub）；契约 AR1005-RC-HOST 同款 |
| SUM-08 | 摘要 = `叙述头（"以下叙述基于第 N 回合快照；与台账冲突时以台账为准"）` + LLM 叙述 + 台账块（LED-06）；叙述 prompt 通过 `customInstructions` 追加：不得复述台账中"已完成"的 id，聚焦开放工作、决策及理由、未决问题 | 单测：prompt 含 closed-id 列表 |
| SUM-09 | **逐调用分类**：包装器按提示形态把调用归类为 `history`（`<conversation>` 开头）/ `turn-prefix`（`# Conversation` 开头）；分类依赖 pi 内部文案，由契约 **SC-HOST-09** 钉住——文案漂移 → 契约变红 → 控制器在运行时探测到未知形态时**降级为"只做装配后校验"并置 `shadow`**（不在不可验证的状态下继续提交） | 单测 + 契约 |

### 5.6 台账（`ledger/*`）

台账是**确定性**的（不经 LLM），**落盘时刻**重新生成，描述"现在的真相"；LLM 叙述是快照时刻的上下文。

摘要装配顺序与分隔：

```
<叙述头 + LLM 叙述>
<cc-core-ledger v="1">
## Open work
## Directives (verbatim)
## Verification
## Background
## Closed (one-line)
</cc-core-ledger>
<read-files>…</read-files> <modified-files>…</modified-files>   （pi 原样追加）
```

| ID | 要求 | 验收 |
|---|---|---|
| LED-01 | **预算与降级顺序**：总长 ≤ `COMPACTION_LEDGER_MAX = 12000` 字符（新增于 `lib/context-budget.ts`，**不**进已发布的 `CONTEXT_BUDGET` 对象——其形状已被 rules-wiring 测试钉住）。超限时**按序降级**（每步只降级、不静默丢弃，降级数计入遥测）：① Closed → 仅计数；② Verification → 仅最近一条测试结果；③ Directives 的 `normal` 类从最旧起折叠为"首 120 字符 + 指针"，再退为纯指针行；④ Background → 一行一项；⑤ Open work 的描述字段按字段钳制（保留 id、status、branch/tab、rework_count 等**身份与状态字段**，钳制 objective/note/question 文本）；⑥ Open work 条数超过 `maxOpenItems`（默认 60）时，超出部分退为"`+K more — full list in <board path \| .pi/goals/>`"。**Tier A（结构化开放状态）的身份与状态字段在条数 ≤ `maxOpenItems` 时永不丢失**；超出条数的部分由外部持久源承载（board / goal 文件，LED-08） | 单测：逐级超限夹具，断言每级降级后 Tier A 的 id+status 全在；超出 `maxOpenItems` 时出现外部指针且遥测计数 |
| LED-02 | **Directives（用户指令）**：被压区内所有**人类**用户消息，分两类：`standing`（命中可配置的约束模式：中 `不要\|禁止\|必须\|一律\|始终\|只能\|不得\|别`、英 `never\|always\|must\|do not\|don't\|only\|without` 等，保守匹配，宁多勿少）与 `normal`。预算 `directivesMax`（默认 5 000 字符）；单条 ≤ `perDirectiveMax`（1 500，超出取头部 + 指针）。**保留顺序**：`standing` 新者优先逐字 → `normal` 新者优先逐字；超预算时**最旧的 `normal` 先折叠**（首 120 字符 + `[#<entryId> @<time>]` 指针），`standing` 最后折叠；**任何指令都至少保留一行指针**（≤ `maxDirectiveLines`=100 行，之后仅计数 `+K older directives — originals remain in the session file`）。完整原文始终在 pi 会话文件中（pi 不删旧条目），可由 `session_recall` 文本检索找回。rex-flow 派单指针消息（角色头 / `读 …dispatch… 后按其中派单开工`）归类为 `flow-dispatch`，不算人类指令 | 单测：分类夹具（standing/normal/flow-dispatch）；超预算夹具：最旧 normal 先折叠、standing 最后；指针行含 entryId；`+K older` 计数正确 |
| LED-02b | **跨轮继承**：上一次压缩摘要中的台账块（按分隔符解析，版本未知/损坏 → 静默丢弃并记遥测）的 Directives（含已折叠的指针行）并入新台账，再按 LED-02 重新排序/折叠；指针行不丢（折叠只会变短，不会消失） | 单测：多轮压缩夹具（≥3 轮，standing 指令跨 3 轮仍在） |
| LED-03 | **goal 台账复用** `extensions/goal/goal-compaction.ts#buildCompactionSummary`（不得再实现第二套格式）；终态 goal 一行 | 单测；源码扫描无重复格式化 |
| LED-04 | **Verification/Background**：最近一次测试命令及其结果、最近 commit 摘要；在途 bg-shell 任务、subagent、后台 `flow-watch` 监听（目标/超时）；完成即移除 | 单测 |
| LED-05 | **rex-flow（orchestrator 档）**：激活条件 = 找到**已关联**的 board（LED-05b）**或** 分支内出现 `===FLOW-REPORT===` / `flow-board` / `flow-dispatch` / `flow-watch`；未激活 = 零开销、零输出。内容：每个**与本会话关联**（LED-05b）且开放（stage≠done）的 run 全量——id、objective（≤120 字符）、stage、spec、tasks（`<run>/<task>` status、branch、tab、rework_count、最近 note ≤100 字符）、open gates（id/question ≤150 字符/run/task）；每个 (run,task) 最近一条哨兵（≤12 条）；**已闭环** run/task 压成一行 `✔ <run> <objective≤60> — N/N merged`，最多 8 行 + `+K older (see board)`；board 上**未与本会话关联**的开放 run 只给一行计数 `other open runs on this board (not touched by this session): K` | 合成夹具 + 下条 |
| LED-05b | **board 发现与关联（不硬编码目录命名，且不得串入其他项目）**。**发现**（E8，三种命名夹具均可发现：`--<root>--`、无破折号/按 ws_root 命名、旧布局 `~/rex-flow/boards/*.json`）候选来源：① 配置 `ledger.rexFlow.boardPath`；② 本会话分支内 `flow-board` / `flow-watch` / `flow-dispatch` 调用的 `--board <path>` / board 位置实参、以及派单/证据文件路径（`<project_dir>/dispatch\|evidence/…`）所属的 `project_dir`；③ 在 `~/.rex-flow/projects/*/board.json` 与旧布局中枚举候选。**关联（必须满足其一才视为"可信 board"，否则退化为"仅哨兵"台账，且**不得**声明"台账为准"）**：(a) 来源为 ① 或 ②（会话自己用过它）；(b) `board.deploy.repo` 与当前 cwd 的 git `origin`（`owner/name`，同步读 `.git/config`）一致，**且**该 board 至少有一个 run id 在本会话分支内被观察到（哨兵 / `--run` 实参 / 上一次台账块）。**"全机唯一有开放 run 的 board"不构成关联**（评审 R1-6）。run 级再过滤：只给**本会话观察到的 run id**（分支内观察 ∪ 上一次台账块中的 run id）加详细条目，其余计入 LED-05 的"未关联"计数。找不到/未关联/过大(>2 MiB)/损坏 → 仅哨兵台账 + 遥测原因码（`board-none`/`board-unassociated`/`board-too-large`/`board-corrupt`），**不抛** | 单测：三布局夹具 + 三种失败 + **串项目诱饵夹具**（cwd 为项目 A，机器上另有项目 B 的唯一活跃 run 的 board → 台账**不含** B 的任何 run/task；仅哨兵）+ 关联规则 (a)/(b) 各一例 |
| LED-05c | **`run-closed` 信号**（给 CUT-04）：分支内出现某 run 的 `run-done` 哨兵（或已关联 board 中该 run 已 done）之后的**第一条无 toolCall 的 assistant 消息**之后为边界 | 单测 |
| LED-06 | **叙述与台账的优先级**：叙述头声明"冲突以台账为准"（**仅当 LED-05b 判定 board 可信时对 flow 段如此声明；仅哨兵台账改写为"以下基于对话内哨兵，可能不全，请以 board 为准并重读"**）；台账在落盘时重生成（不使用快照时刻的旧台账） | 单测：快照后 board 状态变化 → 落盘台账反映新状态；未关联 board → 叙述头措辞不同 |
| LED-07 | **隔离与同步性**：每个 provider 独立 try/catch，一个抛错不影响其他（该段输出 `unavailable` 标记）；落盘路径上的 provider 全为**同步**读（board 文件同步读、有大小上限），无 await | 单测（故障注入）；APP-03 |
| LED-08 | **信息保障范围（G4 的验收口径；"输出了栏目"≠"信息没丢"）**：见下表。验收分三层：**机械保障**（Tier A/B，CI 断言：每个结构化开放项的 id+status、每条 standing 指令的原文或指针在**最终摘要字符串**中可检索到）；**尽力而为**（Tier C，不进 CI）；**外部持久源**（Tier D）。台账生成后、提议前，`ledger/assemble.ts` 做一次**自检**：Tier A/B 的每个条目标识符在装配结果中可找到，缺失即视为台账 bug → 本次不提议、遥测 `ledger-self-check-failed` | 单测：自检通过/失败两路；Tier A/B 机械断言 |

**信息保障分层（LED-08）**

| 层 | 内容 | 保障 | 超预算/不可识别时 |
|---|---|---|---|
| A 结构化开放状态 | goal（focused + 其他开放）、flow 开放 run/task/gate（已关联 board）、在途 bg/subagent/flow-watch | **机械保障**：id + status 必在（条数 ≤ `maxOpenItems`）；描述字段可被钳制 | 超条数 → 外部指针（Tier D）+ 遥测计数 |
| B 用户指令 | 被压区内人类用户消息 | **机械保障**：`standing` 与 `normal` 均至少留指针行；预算内逐字 | 折叠为首 120 字符 + `[#entryId @time]` 指针；原文在会话文件（Tier D） |
| C 自然语言开放事项/决策/理由 | 普通对话中未被 goal/flow 结构化的"还没做完的事、已做的决定、被否决的方案" | **无确定性保障**：由 LLM 叙述承载（叙述 prompt 明确要求列出）；W2 用"植入事实"合成语料做离线抽检（不进 CI） | 无；这是本设计**明确承认**的残余风险（R12） |
| D 外部持久源 | board、`.pi/goals/`、会话 jsonl（pi 不删旧条目） | 不属摘要；摘要内给出指针 | — |

### 5.7 落盘（`apply.ts`）

在 apply 点（POL-07 全部条件）且 `state===ready` 且 `P ≥ applyRatio` 时执行；**提议阶段**全部为同步运算。返回 draft 只是**提议**（`proposed`），是否提交由宿主决定，确认见 APP-08。

**前置校验**（任一失败 → `discarded(原因码)`，不提议）：

| 码 | 校验 |
|---|---|
| V1 | 快照时的分支路径 id 序列仍是当前分支的**前缀**（`session_tree`/fork/导航后失效） |
| V2 | 快照之后当前分支上**没有**新的 compaction 条目 |
| V3 | `firstKeptEntryId` 仍在当前分支，且仍是合法切点 |
| V4 | 快照之后追加的 `context_edit` 若 `targetId` 落在被压区（cut 之前）→ **丢弃**（保守：编辑可能意在移除内容，旧摘要不能把它带回；H15）。**范围含 `event.entries` 中此前 handler 已提议的 `context_edit` draft**（同边界前序 handler）；排在我们之后的 handler 无法预见，由 APP-08 的 V4' 事后审计覆盖 |
| V5 | `contextWindow`/有效 reserve 未使 `T_n` 变化超过 10%（模型切换等）；否则丢弃 |
| V6 | 摘要已通过 SUM-04 |
| V7 | POL-07 的全部 apply 点安全条件（stopReason 排除 length/error/aborted、无待处理的原生恢复、outcome）——**两个 apply 点都检查**（修订：此前 `agent_before_settle` 不检查） |
| V8a | **硬容量闸（所有路径：draft 与 threshold/overflow 供稿；INV-12）**：`estimatePost(summary, 当前尾部) ≤ hardFitRatio × T_n`（默认 0.9）；**overflow 路径**用更严的 `overflowFitRatio`（默认 0.75）。不满足 → 丢弃/拒绝供稿，绝不放宽 |
| V8b | **效率闸（仅 draft 路径）**：`estimatePost ≤ preRatio × T_n`（否则压了也会立刻再触发，形成压缩跑步机）；不满足 → 丢弃并以新 cut 重来。供稿路径**不适用** V8b（紧急场景允许压得没那么狠），但 V8a 永远适用 |
| V9 | 本会话未被降级为 `shadow`/`off`，且 `signal` 未中止 |
| V10 | **同边界冲突**：`event.entries` 中已存在 `compaction` draft（他人已在压缩），或存在会改变被压区内容的 `context_edit` draft（V4）→ 本边界不提议，快照**保持 ready**，下一个边界重新走 V1–V10 |

| ID | 要求 | 验收 |
|---|---|---|
| APP-01 | draft 形态：`{type:"compaction", summary, firstKeptEntryId, details:{readFiles, modifiedFiles, ccCore:{v:1, origin:"precompute", proposalId, cutClass, providers:[…]}}, usage}`（`proposalId` = 每次提议新生成的随机 nonce，写入 `details.ccCore` 以便对账）；返回 `entries: [...event.entries, draft]`（H5(a)） | 单测 |
| APP-02 | V1–V10 每一条各有一个"丢弃/不提议 + 原因码"的单测（V8a/V8b 各自独立），另有"全过 → 提议"一例 | 单测 ×12 |
| APP-03 | **同步无等待**：提议路径零 LLM/网络/文件异步；`applyMs`（含台账重生成与自检）在 1 万条目夹具上 ≤ 100 ms（宽松上界） | 单测（断言 handler 为同步完成路径 + 计时） |
| APP-04 | **同边界 draft 仲裁**（修订：我们**无法**单方面保证"无论注册顺序都共存"，H5(b)）。规则：① 我们**追加不覆盖**（`[...event.entries, draft]`）；② 先于我们的 handler：V10 检测后避让；③ core 内各模块在 `turn_end`/`agent_before_settle` 的 handler **先于**本模块注册，且 core 内**不得**产生 `compaction`/`context_edit` draft（源码扫描：`context_edit` 与 `type:"compaction"` draft 仅出现在本模块）；④ 后于我们的 handler（含 core 外扩展）可能覆盖或追加：不阻止，由 APP-08 对账**检测**并分类（`lost(overridden)` / `conflict-edit`）；⑤ 两个 fake handler 先后返回 entries 的矩阵测试：我们在前/在后 × 对方追加/覆盖，断言结果与分类符合上述规则 | 单测矩阵 + **BLK-2**（真实宿主）+ 源码扫描 |
| APP-05 | **seam 通知时序**：`before`（"意图"）在**返回 draft 之前**同步通知；`after` **仅在对账确认 committed 之后**通知，且**恰好一次**；`lost` 时**不**通知 `after`（订阅方对"before 无 after"的容忍义务与原生 `session_before_compact` 被 cancel/失败一致，H11；S5 行为表须证明其无不可逆副作用）。`info` 携带 `origin:"boundary-draft"`、`midRun`、对账得到的**真实 `entryId`** | SM-02 + **BLK-2** |
| APP-06 | 提议体任何异常 → 返回不含本模块 draft 的结果（不抛进 pi，保持 `event.entries` 原样），遥测记 `apply-error` | 故障注入 |
| APP-07 | 快照**仅在 committed 或 lost 时消耗**；`proposed` 期间同一快照不可再次提议；committed 后立即清空 | 单测 |
| APP-08 | **提交对账（INV-13）**：见 §5.2。draft 返回后在触发集的**第一个事件**同步执行对账：命中 → `committed`（写遥测 `applied`、通知 seam `after`、消耗快照）；未命中 → `lost`（原因码：`overridden`=同边界后续 handler 覆盖；`dropped`=其他；`branch-changed`=期间发生 `session_tree`），写遥测 `discarded`、**不**通知 `after`、作废快照。**committed 时附加 V4' 审计**：扫描提交点之后同边界追加的条目，若有 `context_edit` 且 `targetId` 在被压区 → 遥测 `conflict-edit`（压缩已不可撤销，只计数）；同会话累计 `conflictEditDegradeAfter`（默认 2）次 → 降级 `shadow` + 一次 notify（说明存在对被压内容做追溯编辑的扩展）。对账本身 try/catch、无 await | 单测（对账各分支）+ **BLK-2**（含"第一个事件是哪一个"，S1⑦） |

### 5.8 原生兜底腿（`fallback.ts`，`session_before_compact`）

控制器**永不**写 pi 的 compaction 设置，**永不**返回 `cancel`；原生 `enabled` 保持开启作守门员。**供稿路径同样受硬容量闸 V8a 约束（INV-12；宿主不会替我们校验，H13）**。

| reason | 行为 |
|---|---|
| `threshold`（控制器没赶上） | ① 有 `ready` 且通过 V1–V6、V8a、V9 → 返回 `{compaction}`（V7/V8b 不适用）；② 有 `computing` → 在**总 deadline**（FB-07）内等待，遵守 `event.signal`，就绪后同①；③ 无快照/就绪但 V8a 不过 → 用**同一条流水线、以当前时刻重新选 cut 并同步生成**（含台账与校验，**单次尝试不重试**，仍须过 V8a），遵守 deadline 与 `event.signal`；④ 任一步失败/超时/V8a 不过 → 取消本模块在途任务、返回 `undefined`（交回原生） |
| `overflow` | 同 `threshold`，但 V8a 使用 `overflowFitRatio`（更严）；overflow 恢复只有**一次** compact-and-retry 机会（H13），**宁可交回原生也不供一个可能装不下的结果** |
| `manual` | 有 `customInstructions` → **原样交回原生**；无指令且存在 `ready` 快照且通过 V1–V6、V8a、V9 → 使用；否则交回原生（**不**为手动压缩做自己的同步生成） |
| 模式 `shadow` | 恒返回 `undefined`（零行为变化）；模式 `off` 不注册 handler |

| ID | 要求 | 验收 |
|---|---|---|
| FB-01 | 上表 reason × 就绪态 × V8a 结果矩阵逐格测试（含 BLK-3：旧快照过大 → 不供稿 → 重新生成或交回） | 单测 + **BLK-3** |
| FB-02 | 等待遵守 `event.signal`；中止立即返回 `undefined` | 单测（假时钟） |
| FB-03 | ③ 的同步生成失败 → `undefined`，且不留下半成品状态 | 故障注入 |
| FB-04 | 返回的 `compaction` 字段完整：`summary, firstKeptEntryId, tokensBefore, details(含 ccCore.origin:"native-backfill"), usage`，使 pi 照常发 `session_compact`（H6），goal/modes/memory 经**它们自己的 pi 事件订阅**触发（seam **不**参与此路径，避免双触发） | 单测 + H-SC-3 |
| FB-05 | handler 体全部 try/catch；异常 → `undefined` | 故障注入 |
| FB-06 | 不存在返回 `cancel` 的代码路径 | 源码扫描 |
| FB-07 | **总 deadline 与所有权时序**：fallback 从 handler 入口起有**单一总预算** `fallbackDeadlineMs`（默认 150 000，**覆盖等待 + 同步生成的全部时间**，替代此前"等待 120s 再生成再重试"的串联）。时序：入口记 `deadlineAt` → 等待/生成均以剩余预算为界 → 超时或 `signal` 中止时：`generation++`（旧任务晚到结果一律丢弃）、对旧任务 `abort()`、**立即**返回 `undefined`（不等旧任务真正结束）、单飞锁随 generation 释放、遥测 `fellthrough(reason:"deadline")`。同步生成**不重试**（避免把用户等待翻倍；重试仅用于后台预压路径） | 单测（假时钟 + 延迟 stub：超时点、晚到结果被丢弃、锁释放、不 unhandled） |
| FB-08 | **原生摘要事后审计**：`session_compact`（`fromExtension===false`，即原生自己生成）到达时，对该摘要做 SUM-04 的装配后校验（⑤–⑦）；不通过 → 遥测 `native-summary-invalid` + 一次 `ctx.ui.notify`（仅 `ctx.hasUI`），**不**尝试改写。**因此"空/截断摘要永不落盘"的承诺只覆盖本控制器提议/供稿的结果（INV-5/G4）；原生自己生成的空摘要无法阻止（H10），只能审计告警** | 单测 + **BLK-5** |

### 5.9 seam（`lib/compaction-seam.ts`）与订阅方（W5）

draft 路径不触发 pi 压缩事件（H3/H11）。`lib/compaction-seam.ts` 提供：`registerCompactionSubscriber({before?, after?})`、`notifyBefore(info)`、`notifyAfter(info)`；`info = {origin:"boundary-draft", entryId?, midRun, tokensBefore?, summaryChars}`；按 `entryId` 去重。**`before` = 提议意图（返回 draft 前，此时无 entryId）；`after` = 对账确认提交后（带真实 `entryId`，APP-05/08）。`before` 后可能没有 `after`（提议丢失）——订阅方须容忍，这与原生 `session_before_compact` 之后被 cancel/失败等价。**

订阅方的做法：把各自现有压缩钩子的**函数体抽成命名函数**，同时被 (a) 原有 `pi.on("session_before_compact"/"session_compact")` 与 (b) seam 订阅调用——**原生路径行为不变**。

| ID | 要求 | 验收 |
|---|---|---|
| SM-01 | seam 自包含、同步、订阅方异常互相隔离；`lib/` 不 import `extensions/` | 单测 + 依赖扫描 |
| SM-02 | draft 路径：**已提交**时 goal/modes/memory 的 before 与 after 各触发**恰好一次**；**提议丢失**（BLK-2(a)）时仅 before 一次、无 after，且订阅方无残留不可逆副作用；原生落盘（含 FB-04 供稿）：各**恰好一次**，且 seam 未被调用 | 集成测试（vitest，`test/lib/`）：{已提交, 提议丢失, 原生} × 三订阅方；BLK-2 |
| SM-03 | **goal 在 `midRun:true` 时不得 `queueContinuation`**（run 仍在继续，重复排队会产生多余回合）；post-compact reminder 的消费行为以 S5 行为表为准 | 集成测试 + S5 表 |
| SM-04 | modes：`statsPresenter.invalidate()`、bypass 安全提醒、`persistState` 在 draft **已提交**后（after）同样发生；memory：`stageUnextractedTail` 在提议返回前（`before`）发生 | 集成测试 |
| SM-05 | 既有订阅方测试**不改期望**即全绿（行为保持证明） | `pnpm run test` |

#### §5.9a S5 逐订阅方行为表（W0 审计回填，2026-11-09；W5 实现以此表为准）

审计基线：`extensions/goal/goal.ts`（`session_before_compact` ~:2012、`session_compact` ~:2017）、`extensions/modes/index.ts`（`session_compact` ~:1664）、`extensions/memory/automation.ts`（`session_before_compact` ~:581）。recall 无压缩钩子（门控按 turn 计）。**draft 路径不触发任何 pi 压缩事件已由契约钉住**（`compaction-boundary.test.ts`：draft 提交全程无 `session_before_compact`/`session_compact`）——故下表"draft 路径"列描述的是 **W5 seam 必须补上的动作**，而非现状。

| 订阅方 | 原生路径 before（`session_before_compact`） | 原生路径 after（`session_compact`） | draft 路径 W5 seam 做法 | midRun 约束 | "before 无 after"残留副作用 |
|---|---|---|---|---|---|
| **goal** | `lifecycle.handle({tag:"usage-accounted"})` + `accountProgress(ctx)`（用量记账快照落 ledger） | drafting 直接 return；`persist(ctx)`（focused goal 落盘）→ `beginAccounting()`（**时钟段重置**）→ `shouldArmPostCompactReminder` 时置 `postCompactReminderPending=true`（**reminder 武装**，消费点在下一次 goal prompt 构建，注入一次 `[POST-COMPACTION RESYNC …]` 块后自清）→ `queueContinuation(ctx, true)`（**排队续跑**） | before = usage-accounted + accountProgress（返回 draft 前同步）；after = persist + beginAccounting + reminder 武装 + queueContinuation（**仅 committed 后**，APP-05） | **不得 `queueContinuation`**（run 仍在继续，SM-03）；`persist`/`beginAccounting` 可做；reminder 武装可做（消费点在下一次 goal prompt，midRun 提交后下一次 prompt 仍会到来） | before 两动作无残留（记账反映真实消耗，幂等）；**after 若误发**：时钟段被错误重置（carry 保留、损失段归因）、reminder 误武装（下一次 goal prompt 注入误导性"刚被压缩"文案、一次性）、多余 continuation run——三者即"after 仅 committed"与 SM-03 的依据，均**可自愈、非数据损坏** |
| **modes** | —（无 before 钩子） | `statsPresenter.invalidate()`（缓存失效，幂等）→ bypass 模式时 `needsBypassSecurityReminder=true`（武装一次性安全提醒）→ `persistState()`（状态文件幂等重写） | after = 三动作原样（committed 后）；before 无动作 | 无特殊约束（三动作全部幂等） | 若 after 误发：stats 失效多余一次（无害）、bypass 提醒多余一次（一次性、无害）、状态文件多重写（幂等）——**无不可逆副作用** |
| **memory** | `signal.aborted` 早退 → `stageUnextractedTail(ctx,"compact-queued")`（把未提取尾部写**一条**队列记录，同步有界盘写；`session_shutdown` 共用同一函数兜底） | —（无 after 钩子） | before = staging（返回 draft 前同步）；after 无动作 | staging 与 run 状态无关，midRun 可做 | staging 是**内容驱动**而非压缩驱动：即使压缩最终未发生，记录仍会在下次 `session_start` 被提取（提取本身有益无害）；同 sessionId 队列**精确合并**（P0-CT-09）使重复 staging 幂等；`state.flushes++` 计数器多增（仅展示）——**无不可逆副作用** |

结论：SM-02/03/04 的设计（before=意图时点同步动作、after=仅 committed、midRun 跳过 goal 的 queueContinuation）与上表一致；无需调整 §5.9 需求行。

### 5.10 状态、遥测、配置、开关（`state.ts`/`settings.ts`/`index.ts`）

| ID | 要求 | 验收 |
|---|---|---|
| ST-01 | **会话 entry** `cc-core-compaction`（`pi.appendEntry`，display-only，不进 LLM）：每个**周期结局**写一条（`applied`/`discarded(lost)` 在对账时写），`data:{v:1, outcome:"applied"\|"served"\|"discarded"\|"refused"\|"fellthrough"\|"infeasible", reason?, origin, cutClass?, summaryChars?, tokensBefore?, tokensAfter?, estPostTokens?, computeMs?, applyMs?, waitedMs?, validated:boolean, summaryModelFallback?:boolean, ledger?:{tierADegraded, directivesCollapsed, directivesPointerOnly, openOverflow}, conflictEdit?:number}`；**不含**摘要/台账正文（INV-7）。customType 与字段集冻结 | 单测 + 契约 SC-ENT-01 |
| ST-02 | **设置** `~/.pi/agent/core-compaction.json`（经 `lib/settings.ts`：缺失/损坏返回默认、原子写）：`mode:"off"\|"shadow"\|"on"`（默认 `on`）、`precomputeRatio`、`applyRatio`、`targetPostRatio`、`hardFitRatio`、`overflowFitRatio`、`summaryTokenEstimate`、`keepSlackTokens`、`summaryModel`、`summaryThinking`、`summaryMaxTokens`、`fallbackDeadlineMs`、`minNarrativeChars`、`minPrefixChars`、`maxSummaryChars`、`idleGapMs`、`refusedCooldownTurns`、`degradeAfterRefusals`、`conflictEditDegradeAfter`、`minPrecomputeGapTurns`、`reconcileScanMax`、`directivesMax`、`perDirectiveMax`、`maxDirectiveLines`、`maxOpenItems`、`standingPatterns`、`ledger:{rexFlow:{enabled, boardPath?}}`、信号权重表。默认值见附录 C | 单测（缺失/损坏/越界/原子写） |
| ST-03 | **环境变量** `PI_CORE_COMPACTION=off\|shadow\|on` 优先于配置文件；`/compaction mode …` 写配置并在下一次评估生效（无需 `/reload`，因 settings 在每次 `session_start` 与命令后重读） | 单测 + H-SC-5 |
| ST-04 | **命令** `/compaction`（= `status`）：输出模式、有效 `T_n`、当前 `P`、状态机状态（含 `proposed`/`infeasible-window` 及"需要 T_n ≥ …"）、最近一次结局与原因码、冷却剩余、台账降级计数；`/compaction mode <off\|shadow\|on>`。无 UI（rpc/print）下不抛 | 单测（stub ctx） |
| ST-05 | **降级**：SUM-05 的累计拒绝、seam 订阅方异常、`apply-error` 连续出现、APP-08 的 `conflict-edit` 累计、SUM-09 的未知提示形态 → 本会话 `shadow` + 一次 `ctx.ui.notify`（仅 `ctx.hasUI`）；不跨会话持久 | 单测 |
| ST-06 | 装配：`extensions/index.ts` 中在 `memoryExtension`/`goalExtension`/modes 之后、`ccPanels` 与 economy 之前（`session_before_compact` 为"最后非空者胜"，且仅本模块返回 `compaction`，次序不影响正确性，但记录在案）；pi-compat 失败自禁用（POL-08）；`session_start` 重置会话态 | 装配顺序测试 |

---

## 6. 派工拆分

**批次与合并顺序**（每个任务一个分支/worktree；同批可并行；**文件所有权互不相交**）：

```
B1: W0                 （含 BLK 基线；未交付前 W3/W4/W5 不得开工——"冻结 W3/W5"）
B2: W1 ∥ W5            （W5 须等 S5 行为表与 S1⑦；W1 先落 types.ts）
B3: W2 ∥ W3 ∥ W6
B4: W4 ∥ W7 ∥ W8
B5: W9
```

| 任务 | 内容 | 拥有的文件（独占写） | 依赖 | 验收需求 | 测试位置 |
|---|---|---|---|---|---|
| **W0 契约 + 宿主保真 + 阻断性用例** | 先在 `test/contracts/README.md` 登记 §8 全部条目；建**宿主保真测试脚手架**（H16 配方：`fauxProvider` + `ModelRuntime.registerNativeProvider` + `createAgentSession` + 真实 `SessionManager`，供 BLK-* 与 W3/W4/W5 的集成测试复用）；写契约测试钉 H1/H3/H5/H6/H7/H8/H12–H15（探测不可行者 `test.todo`+Phase，**BLK-1…5 除外，不得 todo**）；一次性 spike 扩展跑 S1–S5，**把结论回填 §4.3 与 §5.9**；交付 **BLK-1…5**（§4.4）的基线与保护断言（保护断言在 W3/W4 实现后转绿，W0 阶段以 `expectedFailure` 钉住基线）。**W0 的完成判据 = BLK 基线全部落地且 S1–S5 结论回填；BLK 任一在宿主下不可构造 → 回报用户** | `test/contracts/**`（新增 `compaction-*.test.ts`）、`test/contracts/support/compaction-host.ts`（脚手架）、`test/spikes/compaction-*`、本 spec §4.3/§4.4/§5.9 | — | §4.3、§4.4 全部、契约行 | `pnpm run contracts` |
| **W1 纯函数核心** | `types.ts`（**首个提交**）、`policy.ts`（含 POL-09 可行性、POL-10 估算口径）、`cutpoint.ts`（容量优先）、`signals/generic.ts`、`validate.ts`（逐子调用 + 装配后）、`settings.ts` | `extensions/compaction/{types,policy,cutpoint,validate,settings}.ts`、`extensions/compaction/signals/generic.ts`、`extensions/compaction/tests/{policy,cutpoint,validate,settings}.test.ts` | W0 | POL-01…07、POL-09/10、CUT-01/02/03/05/06/07/08、SUM-04、ST-02、ST-03(env 部分) | node:test（`extensions/compaction/tests/`，登记 `nodeTestDirs`） |
| **W2 回放与校准** | `scripts/compaction-replay.mjs`：读 jsonl 语料→用真实 `policy/cutpoint` 模拟→聚合指标（含 M1 阈值前提交率、M7 可行性、M9 速率/burst 分布、M10 白做率，并输出 O1/O2 三方案对比）；合成夹具；`--self-check`；跑本机+第二台机器语料，校准附录 C 默认值，**回填 docs 校准节** | `scripts/compaction-replay.mjs`、`test/lib/compaction-replay.test.ts`、`test/fixtures/compaction/**`（合成） | W1 | 回放 AC（§7.2）、INV-7 | vitest `test/lib/` |
| **W3 摘要与提议** | `preparation.ts`（context_edit 感知）、`summarizer.ts`（`streamFn` 包装器、逐子调用捕获）、`apply.ts`（V1–V10、提议、对账）、`state.ts`（状态机 `proposed/committed/lost`+遥测 entry） | `extensions/compaction/{preparation,summarizer,apply,state}.ts` + 对应 tests | W0（S1/S2/S3 + **BLK 基线**）、W1 | SUM-01/02/03/05/06/07/08/09、APP-01…08、ST-01、POL-07（落地）、**BLK-1/2/4 转绿** | node:test |
| **W4 兜底腿与装配** | `fallback.ts`（V8a、总 deadline、事后审计）、`index.ts`（事件装配、对账触发集、`/compaction`、降级、pi-compat）、`extensions/index.ts` 一行、`scripts/run-tests.mjs` 注册 | `extensions/compaction/{fallback,index}.ts`、`extensions/index.ts`、`scripts/run-tests.mjs` + tests | W3 | FB-*、ST-03(命令部分)、ST-04/05/06、POL-06/08、INV-1/2/3/11/12/13、**BLK-3/5 转绿** | node:test + `test/lib/compaction-wiring.test.ts` |
| **W5 seam 与订阅方** | `lib/compaction-seam.ts`（before=意图 / after=确认提交）；goal/modes/memory 钩子函数抽取 + seam 订阅 | `lib/compaction-seam.ts`、`extensions/goal/goal.ts`（仅压缩钩子区域）、`extensions/modes/index.ts`（仅 `session_compact` 区域）、`extensions/memory/automation.ts`（仅 `session_before_compact` 区域）、`test/lib/compaction-seam.test.ts` | W0（S5 + S1⑦） | SM-01…05 | vitest + 既有三模块测试 |
| **W6 台账核心** | `ledger/{types,assemble,goal,directives,files,verification,bg}.ts`（含 Tier 降级顺序、指令分类、自检 LED-08）；`lib/context-budget.ts` 常量 | `extensions/compaction/ledger/**`（除 `rex-flow.ts`）、`lib/context-budget.ts` | W1(types) | LED-01/02/02b/03/04/06/07/08、INV-8 | node:test |
| **W7 rex-flow 台账** | `ledger/rex-flow.ts`（发现 + **关联**）、`signals/rex-flow.ts`（`run-closed`）、三布局 board 夹具 + **串项目诱饵夹具**、哨兵解析 | `extensions/compaction/ledger/rex-flow.ts`、`extensions/compaction/signals/rex-flow.ts`、`test/fixtures/compaction/rex-flow/**` | W6 | LED-05/05b/05c/06、CUT-04、INV-6 | node:test |
| **W8 长程信号** | `signals/long-task.ts`：`goal-step`、`git-commit`、`verified`（测试命令正则可配置，默认见附录 C） | `extensions/compaction/signals/long-task.ts` + tests | W1 | CUT-03 扩展用例、信号单测 | node:test |
| **W9 真机验收与收口** | 真机 H-SC-*；docs（en/zh `compaction.md`、`architecture.md` 模块数 13→14）；`AGENTS.md`/`AGENTS.zh.md`（模块数、布局、磁盘表、环境变量表）；CHANGELOG/PROGRESS/DEVIATIONS；`spec/README.md`；升级金丝雀加三项（§7.3：H3/H5/H12）；回填本 spec 状态 | 上述文档文件、`test/lib/upgrade-canary.test.ts`（仅追加） | W1–W8 | §7 全部 | 三门 + 真机 |

**每个任务的提交规约**：先写验收映射（需求 ID → 测试名）→ 先红后绿的证据（bug 类）或 trace（重构类）→ 实现 → `pnpm run check` / `pnpm run test` / `pnpm run contracts` 全绿 → 独立只读审查实际 diff → 修复 → 本地提交。提交信息前缀 `compaction(Wn):`。测试期望**不得为"让它过"而调整**。

**基线与派工前置（2026-11-09 核对）**：此前列出的与本 spec 无关的未提交改动（`extensions/modes/*`、`AGENTS.md`、`CHANGELOG.md`、`DEVIATIONS.md`、`docs/{en,zh}/modes.md`、`test/lib/adjudication-parity.*`）**已提交**（HEAD `afcff29`），工作区现仅含本 spec 的三个文件（`spec/README.md` 已修改；本 spec 与旧草案**未跟踪**）。**派工前必须先提交这三个文件**——各任务的分支/worktree 从提交创建，否则 worker 看不到 spec。W5（改 `modes/index.ts`）与 W9（改 `AGENTS.md`/`CHANGELOG.md`/`DEVIATIONS.md`）开工前仍须再次 `git status` 核对基线，**不得**覆盖或回退他人改动。

---

## 7. 验收

### 7.1 自动化门禁（全部退出 0 才算完成）

`pnpm run check` · `pnpm run test` · `pnpm run contracts`；新增 node:test 目录登记于 `scripts/run-tests.mjs` 的 `nodeTestDirs`。不得直接调用 vitest/tsc。

### 7.2 回放验收（W2，本地语料，**不进 CI**，结果记入 `docs/zh/compaction.md`）

| 指标 | 定义 | 校准目标 |
|---|---|---|
| M1 **阈值前成功提交率**（取代旧"就绪率"） | 模拟中，所有**越过原生阈值**的压缩事件里，在越过之前已经走完 `ready → proposed → committed` 的占比。分母含"摘要来不及就绪""就绪但应用时 V8a/V8b 不过被丢弃""被后续 handler 覆盖"等一切未能阻止原生触发的情形（摘要耗时模型 = 实测范围，默认 `10s + 0.5ms/输入 token`；增长模型取语料真实逐回合增量，**不假设线性**）。"摘要就绪"本身不计成功 | ≥ 90% |
| M2 切点合法 | 合法切点占比 | 100% |
| M3 尾部不少于原生 | `tailTokens ≥ keepRecentTokens` | 100% |
| M3b 容量约束满足 | 选出的切点满足 `tail ≤ tailMax`（CUT-08）；且"应用时 V8b 通过率"（以语料真实增量模拟 snapshot→apply 的尾部增长） | 100% / 仅报告 |
| M4 split-turn | 控制器选出的 split-turn 占比 vs 原生切点 | 不高于原生 |
| M5 边界类分布 | 各边界类占比（用于校准 `keepSlackTokens`、权重） | 仅报告 |
| M6 估算阻塞时间 | 原生实测阻塞合计 vs 控制器模型下的落盘时间合计 | 仅报告 |
| M7 可行性覆盖 | 语料各会话所用模型/窗口下 POL-09 判可行的比例；不可行会话按原因分类（`T_n` 过小/`keep` 过大/…） | 仅报告 |
| M8 估算偏差 | `estimatePost` 与压缩后第一次真实 usage 的相对偏差分布（用于校准 `hardFitRatio`、`unknownOverheadTokens`） | 仅报告 |
| M9 速率与 burst 分布（O1 前置） | 逐会话 tokens/分钟的分位数；单回合上下文增量的 p50/p90/p99/max，以及增量 > 5K/15K/30K tokens 的回合占比（取自 assistant `usage` 与 toolResult 体量，只输出聚合） | 仅报告 |
| M10 白做率（O1 前置） | 预压已启动但最终**未提交**（被丢弃 / `lost` / 被原生抢先 / 会话结束）的占比，及其消耗的摘要输入 token 合计 | 仅报告 |

**O1/O2 对比交付**：同一回放须在固定比例（附录 C）、固定绝对提前量（`T_n−X`，X 扫描若干档）、速率自适应三方案下各输出 M1/M3b/M10，供 O2 拍板；不得把任一方案默认值在无该对比时改动。

输出**只含聚合**（INV-7）；`--self-check` 在合成夹具上断言上述指标计算正确，作为 `test/lib/` 单测。

### 7.3 真机验收（W9；"实现 / 自动化 / 真机 / 审查"分开记，夹具通过不冒充真机通过）

环境：真实 pi 1.5.0 TUI（PTY，如 rex/tmux）；**用 `compaction.modelOverrides` 同时设置 `reserveTokens` 与 `keepRecentTokens`，使 POL-09 可行**（例如 `T_n ≈ 120K`、`keepRecentTokens ≈ 8K`、`summaryTokenEstimate` 相应调小；**不要**再用 `T_n ≈ 40K`+默认 keep——该组合在默认参数下判 infeasible，控制器会（正确地）不工作）；用一个仅记录事件名的测试扩展旁证"哪些事件发生过"。宿主边界语义（BLK-1…5）已在 W0 以真实 `AgentSession` 自动化验证，PTY 只覆盖 TUI 呈现与端到端手感。

| ID | 场景 | 通过判据 |
|---|---|---|
| H-SC-1 | `on`，脚本化多轮长对话 | 预压在 `preRatio` 启动；在 `applyRatio` 后的 turn_end 提议并**经对账确认提交**（遥测 `applied`）；**无 "Compacting context…" spinner**；TUI 显示摘要行与成本提示；同一 run 继续；jsonl 有 `compaction`（`fromHook:true`、`details.ccCore.proposalId`）；**无** `compaction_start`；落盘后下一次请求上下文显著变小 |
| H-SC-2 | 对 H-SC-1 的会话 `/resume` | 投影正确、可继续对话、摘要行重放正常 |
| H-SC-3 | 让预压来不及（`preRatio=0.99`）使原生 `threshold` 触发 | 兜底腿在 deadline 内同步生成并供稿（过 V8a）；pi 照常发 `session_compact`；goal/modes/memory 钩子各一次；deadline 超时则交回原生且无悬挂任务 |
| H-SC-4 | `/compact <指令>` 与 `/compact`（无快照） | 走原生（有 spinner）；无我们的介入 |
| H-SC-5 | `PI_CORE_COMPACTION=off`；以及 `compaction.enabled=false` | 前者与未装模块行为一致；后者降为 shadow 且不自动压缩 |
| H-SC-6 | 摘要模型被配成返回空内容/报错 | 校验失败→重试→`refused`→原生接手；会话不崩；`/compaction status` 显示原因码 |
| H-SC-7 | 一次真实 rex-flow run（有开放与已闭环任务）下强制压缩 | 摘要台账含全部**已关联**开放 run/task/open gate，已闭环项仅一行；**机器上另一项目的 board 不出现**；压缩后 orchestrator **无需**重读 board 即可继续派工。**若无法在本期执行，作为"待证据项"列出恢复条件，不得标完成** |

发布门槛：**BLK-1…5 全绿**（自动化、硬门槛）且 H-SC-1/3/5/6 通过且 M1 ≥ 90% → 默认 `mode:"on"` 发布；未满足 → 默认改 `shadow` 发布并在 `DEVIATIONS.md` 记**临时**偏离及恢复条件。BLK 任一红 **不得**以"默认 shadow"绕过发布（shadow 仍会在 `session_before_compact` 之外运行预压，BLK 红说明宿主假设不成立，须先修 spec/实现）。

升级金丝雀追加：H3（draft 不发 `session_compact`、刷新上下文）、H5（`entries` 替换语义）、H12（旧于压缩的最后 assistant 跳过恢复）三条，pi 升级前先跑 `pnpm exec vitest run test/lib/upgrade-canary.test.ts --config vitest.config.ts`。

---

## 8. 契约登记草案（W0 **先**登记再写测试；格式同 `test/contracts/README.md`）

| 契约 | spec ID | 消费方 | 移除条件 |
|---|---|---|---|
| 宿主：`session_before_compact` 返回 `{compaction}` → 跳过摘要 LLM 且照常发 `session_compact`；多 handler"最后非空者胜、仅 cancel 提前返回" | SC-HOST-01 | compaction 供稿腿 | pi 改语义时随版本改写 |
| 宿主：boundary draft `compaction` 经 `appendCompaction(fromHook)` 落盘、刷新下一回合上下文、**不发** `session_compact`/`compaction_start\|end` | SC-HOST-02 | compaction 落盘路径、seam | pi 对 draft 压缩补发事件时 → 本契约变红 → 评估 seam 去重 |
| 宿主：`emitBoundary` 的 `entries` 为"最后返回者覆盖"，事件携带累计 `entries`；所有 handler 跑完后统一提交（后序 handler 可覆盖/追加，含 `context_edit`） | SC-HOST-03 | compaction 提议（`[...event.entries, draft]`）、对账 | pi 改为合并语义时 |
| 宿主：`ctx.getContextUsage().tokens` 在压缩后、下一次 assistant 响应前为 `null` | SC-HOST-04 | compaction policy（POL-04） | — |
| 宿主：公开导出集合（含 `compact`/`generateSummaryWithUsage`/`SettingsManager`/`estimateTokens`/`findCutPoint`/`createAgentSession`）与 **`prepareCompaction` 非公开**（informational：若变公开，可删自建 builder） | SC-HOST-05 | compaction preparation、W0 脚手架 | pi 公开 `prepareCompaction` 时 |
| 宿主：`SettingsManager.create(cwd).getCompactionSettings(model)` 的 `modelOverrides` 解析（键 `provider/id`） | SC-HOST-06 | compaction policy（POL-01） | pi 暴露 settings 给 ctx 时 |
| 宿主：**截断/overflow 恢复的时间戳判旧**——最后一条 assistant 早于最新 compaction 时 `_checkCompaction` 跳过恢复；`turn_end.outcome` 把 `stopReason:"length"` 归为 `completed`；`agent_before_settle` 在 `_checkCompaction` 之后触发（BLK-1 的基线） | SC-HOST-07 | compaction POL-07（INV-11） | pi 改恢复判据时 → 红 → 重审 POL-07 |
| 宿主：**不校验**扩展提供的压缩结果是否装得下（`session_before_compact` 返回值与 boundary draft 均照单全收；BLK-3 基线） | SC-HOST-08 | compaction V8a（INV-12） | pi 增加容量校验时 → 红 → 可放宽 V8a 为 informational |
| 宿主：**`compact()` 调用面**——可选 `streamFn` 为唯一逐调用观测/注入点；`thinkingLevel:"off"` 仅省略 `reasoning` 参数；无 `maxTokens` 参数；length/error 抛错；split-turn 两次调用与固定合并分隔；两类调用的提示开头形态（`<conversation>` / `# Conversation`） | SC-HOST-09 | compaction summarizer、SUM-03/04/09 | pi 改 compact 内部形态时 → 红 → SUM-09 降级路径生效 |
| 宿主：**`context_edit` 仅作用于投影内条目**（针对被压区条目的编辑无效果）；`entry_appended` 不在扩展事件集中 | SC-HOST-10 | compaction V4/APP-08、对账 | pi 向扩展暴露提交事件时 → 红 → 对账可简化 |
| session entry `cc-core-compaction`（display-only；data 见 ST-01，customType 与字段集冻结） | SC-ENT-01 | core 自身、`/compaction status`、回放工具 | 机制下线时 |
| 摘要内台账块 `<cc-core-ledger v="1">…</cc-core-ledger>` 与 `CompactionEntry.details.ccCore`（`v:1`）——**写入用户会话数据，格式冻结** | SC-SUM-01 | compaction（LED-02b 继承）、回放工具 | 永不静默破坏；升级走新版本号 |
| 磁盘：`~/.pi/agent/core-compaction.json`（键集见 ST-02） | SC-CFG-01 | compaction settings | 冻结 |
| 环境变量 `PI_CORE_COMPACTION=off\|shadow\|on` | SC-ENV-01 | compaction settings | — |

> `lib/compaction-seam.ts` 是**包内**接口，不登记契约，由 `test/lib/` 覆盖。

---

## 9. 文档与台账（W9）

- `docs/en/compaction.md` + `docs/zh/compaction.md`（双语同步）：机制、状态机、台账格式、配置/环境变量/命令、校准结论、故障排查；`docs/*/architecture.md` 模块数与装配顺序。
- `AGENTS.md`/`AGENTS.zh.md`：模块数 13→14、布局、环境变量表（`PI_CORE_COMPACTION`）、磁盘表（`core-compaction.json`）。
- `CHANGELOG.md`（下一版本标题下）；`PROGRESS.md`（模块实现状态，中文）；`DEVIATIONS.md`（取代旧草案；如触发发布门槛的临时偏离）。
- 每个模块文件顶部按仓库惯例写**头注释**：spec ID 与设计决策；行为变化同步更新头注释与 docs。
- `spec/README.md` 增加一行指向本 spec；旧草案顶部加"已被取代"横幅（本 spec 提交时已做）。

---

## 10. 风险与开放点

| # | 风险 | 缓解 |
|---|---|---|
| R1 | S1 不通过（draft 在 turn_end 的真实行为与读码不符） | §4.3 已预批降级路径；W0 先做 |
| R2 | draft 路径绕过 pi 压缩事件 → 订阅方漏触发/双触发 | seam + SM-02；契约 SC-HOST-02 变红即警 |
| R3 | 手工 preparation 与 pi 内部漂移 | S2 差分测试 + 升级金丝雀；SC-HOST-05 提示何时可删 |
| R4 | 摘要模型并发/限流（GLM） | 单会话单飞；失败→重试一次→`refused`→原生；不显示错误弹窗 |
| R5 | 默认比例/权重是假设值 | W2 回放校准；改动需同步附录 C 与 docs |
| R6 | 摘要输入 > `summaryModel` 窗口 | SUM-06 预检 → 回退会话模型；仍不行 → 丢弃交原生（**不分块**，NG1） |
| R7 | rex-flow board 路径/格式漂移 | LED-05b 三布局 + 降级为仅哨兵；只读、fail-open |
| R8 | 工作区基线漂移（他人改动与本模块的触点：`modes/index.ts`、`AGENTS.md`、`CHANGELOG.md`、`DEVIATIONS.md`） | §6 基线与派工前置：派工前提交 spec；W5/W9 开工前再核对 |
| R9 | 台账把用户指令原文写入摘要（与原生摘要同类内容，但更"逐字"） | INV-7：遥测不含正文；预算裁剪；文档说明 |
| R10 | 提前压缩 → 主对话 prompt cache 提前失效 | 压缩后上下文很小，重建 cache 成本低；`applyRatio` 延后落盘以降低压缩频率；W2 报告频率 |
| R11 | 后序（core 外）handler 在同边界覆盖/追加，使提议丢失或被追溯编辑（H5(b)/H15）——**无法单方面预防** | APP-04 仲裁规则 + APP-08 对账**检测**；`lost` 不消耗快照、不通知 after；`conflict-edit` 计数并降级 shadow；core 内源码扫描保证自身不产生此类 draft |
| R12 | Tier C（普通对话中的自然语言开放事项）无确定性保障（LED-08）——**明确承认的残余风险** | 叙述 prompt 要求列出开放事项；台账给指令指针与会话文件回溯；W2 植入事实离线抽检；`/compaction status` 暴露降级计数 |
| R13 | 估算偏差（系统提示/工具定义占用、`chars/4` 估算）使 V8a 误判 | `hardFitRatio` 0.9 / `overflowFitRatio` 0.75 的安全边际；overhead 用 `getContextUsage` 校准；M8 报告偏差；overflow 路径宁可交回原生 |
| R14 | 逐调用分类依赖 pi 内部提示文案（SUM-09） | SC-HOST-09 钉住；运行时遇未知形态 → 降级为"仅装配后校验"并置 shadow |
| R15 | 小窗口/大 keep 配置下 POL-09 判 infeasible，控制器不工作 | 设计内行为（原生照常）；`/compaction status` 明示原因与所需 `T_n`；M7 统计覆盖率 |

**开放点（不阻塞 W0–W9 主线，均为 W2 数据落地后的候选增强）**：

| # | 开放点 | 说明 |
|---|---|---|
| O1 | **速率自适应提前量**（2026-11-08 讨论补充）：policy 用最近 N 轮 tokens/min 估计消耗速率，动态计算预压缩启动点，替代固定 `preRatio` | 动机：固定比例（0.60）在慢会话里白做概率偏高，固定绝对提前量（如 "T_n−25K"）在 burst 下（单条大 tool result 5–30K tokens；**E1/E5 只给出压缩耗时与成分，burst 量级尚无取证，由 W2 的 M9 取得**）会被打穿到原生阈值，退回阻塞腿。约束：提前量 ≥ max(摘要耗时 × 消耗速率上界, apply 安全点等待预算, 重试一次预算)；被压区在快照时刻冻结，早压不丢信息，代价主要是白做率，**但提前量增大会同时增大 POL-09 的 `G(P_s)`（快照到应用之间的预期增长），收紧 `tailMax`、抬高 V8b 失败概率**——自适应方案必须与 POL-09 联合求解可行性，不能只看白做率。前置：W2 回放数据（M1、M9 速率与 burst 分布、M10 白做率）先行，用同一回放离线对比 固定比例 vs 固定绝对值 vs 自适应 三方案（W2 交付物，见 §6/§7.2）；policy 为纯函数（§5.3），W1 后可低成本实验 |
| O2 | 附录 C 默认值收敛方向的正式决策：若 O1 采纳，`preRatio`/`applyRatio` 语义由「比例」改为「窗口下界/上界」派生 | W2 校准报告需同时给出两套参数方案供用户拍板 |

**回滚**：`PI_CORE_COMPACTION=off`（环境变量，立即生效于新进程）或 `mode:"off"`；模块是装配线上的一行，移除该行即完全卸载；会话中已写入的 `compaction` 条目与 `cc-core-compaction` 条目是合法的 pi 数据，卸载后无害（`cc-core-compaction` 无 renderer 时不显示）。

---

## 11. 与既有资产的复用关系

| 资产 | 复用方式 |
|---|---|
| `extensions/goal/goal-compaction.ts` | LED-03 直接复用 |
| `extensions/memory/llm.ts#completeText` 的模型/密钥解析 | SUM-06 同款 |
| `lib/settings.ts` | ST-02 |
| `lib/pi-compat.ts` | POL-08 |
| SoL-Pi OCC 的"状态版本化 entry + 会话恢复""可恢复错误白名单+refused 闩锁""steer 废弃待执行选择" | 本 spec 的 ST-01、SUM-05、V1（分支变化即丢弃）；**不照搬**触发/串行执行/plan 依赖 |

---

## 12. 决策登记（用户已确认）

| # | 决策 | 选择 | 放弃了什么 |
|---|---|---|---|
| D1 | 所有权 | 扩展接管常规压缩；原生保留给 `/compact` 手动与 overflow 兜底 | 旧草案"回填为主" |
| D2 | 默认模式 | `on`（接管），自动降级回 `shadow`；`PI_CORE_COMPACTION` 开关；发布门槛见 §7.3 | 先 shadow 一个周期 |
| D3 | 摘要模型 | 可配置（`summaryModel`），默认沿用会话模型 | 固定同模型 |
| D4 | rex-flow 适配器 | core 内置只读适配器（board + 哨兵，缺失降级） | 仅提供 provider seam、由 rex-flow 侧实现 |
| D5 | 并行 | 后台预压与主对话并行；**不做**分块 map-reduce | 分块并行（复杂度） |
| D6 | 手动 `/compact` | 带指令 → 原生；无指令且有就绪快照 → 用快照；否则原生 | 手动也走自己的同步生成 |

> 评审 R1（附录 D）引入的修订**不改变**上述用户决策，只收紧实现边界；其中"G4 保障范围"（LED-08）与"原生摘要只审计不拦截"（FB-08）是对承诺范围的**如实收窄**，派工前请用户知悉。

---

## 附录 A：本地取证的复现口径（W2 工具化）

仅聚合：按会话统计条目数/类型、`compaction` 条目的 `tokensBefore`/`usage`/摘要字符数与前驱间隔、被压区按角色/工具名的字符占比、标记字符串（`FLOW-REPORT`、`flow-board`、run id）在"被压区 / 保留尾部 / 摘要 / 压缩后"四处的出现次数。**不输出正文**。

## 附录 B：摘要内台账块示例（合成）

```
<cc-core-ledger v="1">
## Open work
[goal g2 · in-progress] <objective one-liner> — next: <step>
[flow r7 · executing] <objective≤120>  spec=<specs/r7-x.md@ab12cd34>
  r7/t1 doing  branch=w/x-1  tab="w/x-1 · w1"  rework=0
  r7/t2 review branch=w/x-2  tab="w/x-2 · w2"  rework=1  note: <≤100>
  gate G3 open (r7/t2): <question≤150>
  last sentinels: r7/t1 worker:ready · r7/t2 gatekeeper:rework
## Directives (verbatim)
- <最新的用户指令原文>
- …（older: "<首 120 字符>…"）
## Verification
last test: `pnpm run test` → pass (2 min ago) · last commit: <hash> <subject≤60>
## Background
bg-3 `pnpm run dev` running · flow-watch r7/t1 (timeout 7200s)
## Closed (one-line)
✔ r5 <objective≤60> — 3/3 merged · ✔ r6 … · +2 older (see board)
</cc-core-ledger>
```

## 附录 C：默认参数（**假设值**，W2 校准后回填；修改须同步 docs）

| 参数 | 默认 | 说明 |
|---|---|---|
| `mode` | `on` | D2 |
| `precomputeRatio` / `applyRatio` / `targetPostRatio` | 0.60 / 0.75 / 0.45（×`T_n`） | E7：预压窗口远大于摘要耗时；`q` 为切点容量约束的目标（POL-09），须 `q < p < a` |
| `hardFitRatio` / `overflowFitRatio` | 0.90 / 0.75（×`T_n`） | V8a：所有路径的硬容量闸；overflow 更严（只有一次恢复机会，H13） |
| `summaryTokenEstimate` | 12 000 tokens | POL-09 的 `S`；有上次摘要时取 `max(默认, 1.2×上次摘要)` |
| `unknownOverheadTokens` | 8 000 | POL-10：`getContextUsage().tokens` 为 null 时对系统提示/工具定义占用的保守估计 |
| `keepSlackTokens` | 40 000 | 尾部窗口 `[keep, min(keep+slack, tailMax)]` |
| 边界权重 | run-closed 100 · goal-step 90 · user 80 · git-commit 60 · verified 55 · idle-gap 50 · plain-turn 30 · tool-turn 10；`λ = 20` | CUT-03 只钉**序**，不钉绝对值 |
| `idleGapMs` | 600 000 | 空闲间隔边界 |
| 测试命令正则（verified） | `pnpm run test`、`npm (run )?test`、`vitest`、`node --test`、`pytest`、`go test`、`cargo test`、`bun (run )?test`；退出成功 | 可配置 |
| `summaryThinking` / `summaryMaxTokens` | `off`（S3 可能改 `minimal`）/ 由 S3 结论定（注入不可行则不设） | SUM-03 |
| `minNarrativeChars` / `minPrefixChars` / `maxSummaryChars` | 400 / 100 / 40 000 | SUM-04（历史摘要 / turn-prefix 摘要 / 总长） |
| `COMPACTION_LEDGER_MAX` | 12 000 字符 | INV-8 |
| `maxOpenItems` | 60 | LED-01：Tier A 逐项保障的条数上限 |
| `directivesMax` / `perDirectiveMax` / `maxDirectiveLines` | 5 000 / 1 500 / 100 | LED-02 |
| `standingPatterns` | 中：`不要\|禁止\|必须\|一律\|始终\|只能\|不得\|别`；英：`never\|always\|must\|do not\|don't\|only\|without` | LED-02：保守匹配，宁多勿少；可配置 |
| `fallbackDeadlineMs` | 150 000 | FB-07：fallback 单一总预算（等待 + 同步生成），替代旧 `waitMs` |
| `reconcileScanMax` | 50 | §5.2 对账自叶向前扫描上限 |
| `refusedCooldownTurns` / `degradeAfterRefusals` / `minPrecomputeGapTurns` / `conflictEditDegradeAfter` | 15 / 3 / 3 / 2 | |
| 重试次数 | 后台预压 1；fallback 同步生成 0 | SUM-05 / FB-07 |
| V5 窗口变化容忍 | 10% | |

---

## 附录 D：评审修订记录（R1，2026-11-08）

外部评审对 v1 提出 8 项缺口。逐项对照 pi 1.5.0 源码核实后的处置如下（"核实"= 读码；BLK 用例在 W0 以真实 `AgentSession` 复现并转为阻断性验收，本轮未独立运行评审的合成复现）：

| # | 评审结论 | 核实 | 处置（落点） |
|---|---|---|---|
| 1 | P1：turn_end 提前压缩吞掉截断恢复；`completed` 不充分 | ✔ `_checkCompaction` 按时间戳判旧（`agent-session.js:2413–2428`）；`length` 被归为 completed（`:500–503`）；恢复需 `isRecoverableLength`（`pi-ai overflow.js:177`） | H12；POL-07 重写（排除 length/error/aborted + 待恢复标志，两个 apply 点均检查）；V7；INV-11；**BLK-1**；SC-HOST-07 |
| 2 | P1：返回 draft≠提交；`entry_appended` 对扩展不可见；后序 handler 可覆盖/追加 `context_edit` | ✔ `emitBoundary` 整体替换（`runner.js:759–790`）；`entry_appended` 不在扩展事件集；`context_edit` 仅作用于投影内条目（`session-manager.js:201–260`） | H3/H5/H15；状态机新增 `proposed/committed/lost`（§5.2）；APP-04 改为**仲裁规则**（不再承诺"必共存"）；APP-05/07/08 提交对账；V4 扩范围 + V4' 事后审计；V10；INV-13；**BLK-2**；SC-HOST-10。**无法单方面预防的部分（R11）如实承认，改为检测+降级** |
| 3 | P1：overflow 回填取消了容量检查 | ✔ 扩展 compaction 原样采用，无容量校验（`:2578–2600`）；overflow 仅一次恢复（`:2470–2490`） | H13；V8 拆 **V8a（所有路径硬闸，overflow 更严）/ V8b（仅 draft 效率闸）**；FB 全表引用 V8a；INV-12；**BLK-3**；SC-HOST-08 |
| 4 | P1：校验闸挡不住 split-turn 局部丢失；`compact()` 无 stopReason/maxTokens | ✔（限定）：`compact()` 无 maxTokens、`off` 只是省略 reasoning、返回无 stopReason、split-turn 两次调用合并（`compaction.js:442–560,686–735`）。**修正**：pi 的 `getSummarizationFailure` 已对 `length/error` 抛错，故"stopReason 校验"只是防御；真正缺口是**逐子调用**不可见与 reasoning-only | H14；SUM-03 重写（`streamFn` 包装器逐调用捕获 + 注入）；SUM-04 分逐调用/装配后两层；SUM-09 分类；S3 扩展；**BLK-4**；SC-HOST-09；R14 |
| 5 | P1：台账有限预算与"全量不丢"矛盾；自然语言开放事项无确定性识别 | ✔ 逻辑矛盾成立 | **分层保障表（LED-08）**：Tier A/B 机械保障（身份+状态、指令至少指针）、Tier C 明确无保障、Tier D 外部持久源；LED-01 改为降级顺序、LED-02 改为 standing/normal + 指针 + 会话文件回溯；LED-02b 跨轮不丢指针；自检；G4 重述；R12 |
| 6 | P1：board 自动发现可能串项目 | ✔ 原 LED-05b ③ 无关联要求 | LED-05b 重写：**发现 + 关联**两步，删除"全机唯一"规则；run 级按本会话观察过滤；未关联 → 仅哨兵且不声明"以台账为准"（LED-06）；串项目诱饵夹具；H-SC-7 加判据 |
| 7 | P2：阈值/尾部/V8 未联合求解，小窗口反复废弃 | ✔ 算例成立（T_n=40K：快照尾部 ≥ 20K，增长 6K，V8 要求 ≤ 24K） | POL-09 联合可行性 + `targetPostRatio`；§5.4 搜索窗口改为容量优先并**新增 CUT-08**；POL-10 估算口径；M1 改为**阈值前成功提交率**、新增 M3b/M7/M8；§7.3 真机配置改为可行组合；R15 |
| 8 | P2：兜底路径可能增加等待；校验失败后原生仍可能落盘空摘要 | ✔ 原 FB 串联等待 120s + 生成 + 重试；原生不校验（H10） | FB-07 **单一总 deadline** + `generation` 所有权时序 + 同步生成不重试；SUM-07 对齐；FB-08 原生摘要**事后审计**；INV-5/G4 把"永不落盘空摘要"**限定为本控制器的结果**；**BLK-5** |

评审的收尾建议（先补强 W0、再冻结 W3/W5）已采纳：§6 的 W0 扩为"契约 + 宿主保真脚手架 + 阻断性用例"，BLK-1…5 为发布硬门槛（§7.3），且 W3/W4/W5 依赖 W0 的 BLK 基线。
