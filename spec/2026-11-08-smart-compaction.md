# Smart Compaction — 并行无感压缩与智能边界切点 设计方案

> **已被取代（2026-11-08）**：本草案（候选 A：Shadow 预计算 + 回填）不满足"扩展接管常规压缩"的意图，已由 [`2026-11-08-smart-compaction-takeover.md`](2026-11-08-smart-compaction-takeover.md) 取代。本文 §2 的 pi 源码取证仍可作参考；§4 对候选 B 的否决理由已在新 spec §4.2 逐条回应。

- **日期**: 2026-11-08
- **状态**: DRAFT(待用户审批)
- **目标仓**: pi-claude-code-core(新扩展 `extensions/compaction/`)+ pi-claude-code-tui(呈现层,Phase 4)
- **参考**: SoL-Pi Online Context Compact(NVlabs/SoL-Pi)、magpie Long conversations(yetone/magpie)、pi 1.5.0 原生 compaction

---

## 1. 背景与目标

### 1.1 问题定义

pi 原生 compaction 在触发时(threshold/overflow/manual),**摘要 LLM 调用被 session 状态机同步 await**,期间:

1. agent run 停摆,用户排队消息压完才 flush(`interactive-mode.js:2757-2768` 的 `queueCompactionMessage`);
2. 手动 `/compact` 期间 `session.prompt()` 直接抛错(`agent-session.js:1666-1668`),还会先 abort 在跑的 run(`agent-session.js:2249`);
3. spinner "Compacting context..." 挂数十秒(GLM 全额模型对 20k+ tokens 摘要输入的调用,实测常见 15–60s,精确值由 Phase 3 埋点量化)。

切点方面,原生 `findCutPoint` 是**纯 token 距离算法**(从尾往回累计 ≥ `keepRecentTokens` 即切),落在哪算哪:可能切在 assistant 中间(split turn,原生被迫做两次摘要补救)、可能切断一个工具调用簇的语义单元,信息留存非最优。

### 1.2 目标

| # | 目标 | 度量 |
|---|------|------|
| G1 | **无感压缩**:压缩的用户感知等待从「一次摘要 LLM 调用」降到 **< 1s** | 回填路径下 `session_before_compact` 返回时不再发生 LLM 调用 |
| G2 | **智能边界**:压缩切点对齐自然对话结构(turn 起点/工具簇边界),减少 split turn 与语义断裂 | split-turn 占比、切点对齐率(遥测) |
| G3 | **永远可回退**:任何预计算失败/校验不匹配,零妥协回退原生路径 | 回退路径产物与 pi 原生完全同构 |
| G4 | **零侵入**:不 patch pi runtime、不改 DEVIATIONS,全部走公开 extension API + 顶层导出 | 代码审查 |

### 1.3 非目标(out of scope)

- 不做多级/分层 summary 架构(单摘要 + 结构化保留清单增强,同原生形态)。
- 不做 KV-cache 感知的全量经济学决策(SoL-Pi 的 cache debt/breakeven 模型——预计算本身**不作废主对话 cache**,经济学退化为"预热调用成本 vs 命中概率",见 §5.3.1)。
- 不做 plan-step 粒度边界(pi 无原生 plan 工具,强依赖不成立;turn/工具簇边界已覆盖主要收益)。
- 不做 magpie 式回放调参 "Tuned for you"(列为 OQ4,遥测数据积累后再议)。
- 不改 cctui 现有 compaction 行的交互形态(仅 Phase 4 加预计算状态呈现)。

---

## 2. 现状取证(一手证据)

### 2.1 pi 1.5.0 原生 compaction 机制

源码:`pi-claude-code-core/node_modules/@earendil-works/pi-coding-agent/dist/`(下称 `dist/`)。

**触发**:
- 阈值公式 `contextTokens > contextWindow - reserveTokens`(非百分比)——`dist/core/compaction/compaction.js:173-177`;默认 `{enabled: true, reserveTokens: 16384, keepRecentTokens: 20000}`(`compaction.js:53-57`)。
- 三条自动路径:post-run 检查(`agent-session.js:2409-2528`)、pre-prompt(`agent-session.js:1498-1504`)、between-turn(`agent-session.js:436-445`);overflow 恢复只试一次(`agent-session.js:2463-2491`)。

**执行(阻塞点)**:
- 全链 `await`:`_runAutoCompaction`(`agent-session.js:2539-2667`)→ `compact()` → `generateSummaryWithUsage()`(`compaction.js:513-542`)。压缩期间 `isCompacting=true`,`isIdle=false`(`agent-session.js:1242-1246, 1084-1087`)。
- 摘要总是用**当前会话模型**(虚拟模型先 resolve);settings 无摘要模型专用键。

**产物结构**:
- `CompactionEntry {type:"compaction", summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook?, systemMessage?}` append 进 jsonl 树(`session-manager.js:891-911`);旧消息**不删**,靠 `buildContextEntries` 按 `firstKeptEntryId` 投影(`session-manager.js:201-229`)。
- summary 以 `compactionSummary` role(投影为 user 消息)进入新 context(`messages.js:7-12`)。

**切点**:
- `findCutPoint`(`compaction.js:334-375`)/投影版 `findProjectedCutPoint`(`compaction.js:555-608`):从最新往回累计 chars/4 估算 tokens,累计 ≥ `keepRecentTokens` 处停,取 ≥ 该位置最近的合法切点;合法切点 = user/assistant/bashExecution/custom/branchSummary/compactionSummary,**绝不切 toolResult**(`isCutPointMessage`,`compaction.js:253-266`)。
- 切点非 turn 起点时为 split turn:`[turnStart, cut)` 段做第二次摘要(TURN_PREFIX prompt)拼接(`compaction.js:693-705`)。

**对本方案最关键的两个 seam(已一手验证)**:

1. **`session_before_compact` 可整体替换压缩内容**。`SessionBeforeCompactResult {cancel?, compaction?: CompactionResult}`(`dist/core/extensions/types.d.ts:1155-1158`);handler 返回 `compaction` 后,`summary / firstKeptEntryId / tokensBefore / usage / details` **全部直接采用、跳过原生摘要 LLM 调用**(`dist/core/agent-session.js:2286-2306` 实测代码:manual 路径;auto 路径同构,`agent-session.js:2561-2593`)。→ **切点由扩展锁定,等待时间由扩展决定。**
2. **压缩全套基建是顶层导出**。`prepareCompaction(pathEntries, settings) → CompactionPreparation`、`compact(preparation, model, apiKey, headers?, customInstructions?, signal?, …) → CompactionResult`、`generateSummaryWithUsage`、`findCutPoint`、`shouldCompact`、`estimateTokens` 均 `import` 自 `@earendil-works/pi-coding-agent` 顶层(`dist/core/compaction/compaction.d.ts` 全文核验)。→ **预计算可复用原生 prompt/split-turn 处理/retry/fileOps,产物与原生路径同构。**

其他相关:`ctx.compact(options)` fire-and-forget 触发器(`types.d.ts:223-228, 268-269`);TUI 压缩队列 `interactive-mode.js:3981-4059`;Esc 中止 `abortCompaction`。

### 2.2 core(pi-claude-code-core)可用 seam

- **扩展装配**:`extensions/index.ts:48-84` `moduleFactories` 数组,新扩展 = 一个 factory;注册顺序有语义(observation-pack 必须占最后 context 槽,`index.ts:73-75`)。
- **事件面**:core 已有 `session_before_compact` 2 处消费(memory staging、modes 缓存失效)、`session_compact` 2 处(memory RV-06 边界、goal RESYNC 重注入)。pi 事件 runner 对 before-event 是**顺序执行、cancel 短路**(`dist/core/extensions/runner.js:807-839`),多 handler 共存无冲突。
- **side-channel LLM 先例**(按复用优先级):
  1. `extensions/memory/llm.ts` `completeText()`(`llm.ts:95-162`)——`completeSimple` + 鉴权轮换重试 + 超时/abort + 统一失败词汇表;
  2. `extensions/goal/goal-auditor.ts` `createAgentSession` 隔离会话骨架(重,本方案不需要);
  3. **pi 顶层导出的 `compact()/generateSummaryWithUsage()`**——prompt/重试/usage 与原生完全一致,鉴权走 `registry.getApiKeyAndHeaders`(memory 同款模式)。
- **token 监控点**:`ctx.getContextUsage(): {tokens, contextWindow, percent}`(`types.d.ts:216-222`)、`message_end`(usage)、`turn_end`。
- **版本 gate**:`lib/pi-compat.ts` `probePiCompat` + `assessEconomyModule` 自禁用先例(`pi-compat.ts:57-94`);core 下限 `MIN_PI_VERSION = "0.87.0"`,dev 锁 1.5.0。
- **配置先例**:host `~/.pi/agent/settings.json` 命名空间键(memory/automation.ts:88-100 模式);自有开关文件(core-economy.json 模式)。
- **bus v2**:加可选 channel 不升协议版本(`bus.ts:54-56` 先例注释);cctui 照 `lib/core-bus.ts` shape-checked 消费,旧 core 静默降级。
- **测试**:新扩展测试放 `extensions/compaction/tests/*.test.ts`(node:test + tsx,加入 `scripts/run-tests.mjs:30-37` 的 `nodeTestDirs`)。

### 2.3 SoL-Pi Online Context Compact(OCC)——借鉴与取舍

机制(NVlabs/SoL-Pi,`src/sol-pi/extensions/online-context-compact/`):plan step 完成点为候选边界;`turn_end` 时 `decideCompaction()` 双门决策——window_protection(逼近窗口无条件压)+ economic(KV-cache 盈亏平衡:`breakevenRequests = writeTokens×(cacheWriteReadRatio−1) / savingTokens`,horizon 由历史 step 耗时外推,首次压缩 horizon×2,后续需偿还 cache debt);执行时 abort run → agent_settled 串行压 → 隐藏消息 `triggerTurn: true` 续跑;取消插队的 threshold 压缩但**从不取消 manual/overflow**;状态全部外置 session custom entry;用户 steer → epoch+1 清统计。

**借鉴**:① 结构边界触发思想(→ 我们的智能切点);② horizon 外推(→ 预热时机决策);③ ProgressSummary 结构化保留清单 `{goal, filesChanged, verification, decisions, nextWork}`(→ 摘要 prompt 增强);④ 状态外置 custom entry + epoch 重置;⑤ 与原生压缩的仲裁纪律(不碰 manual/overflow)。
**不借鉴**:① 串行 stop-the-world(它无并行实现,反而是"并行难做"的反例证据——但它难在**执行**要 abort run,我们难在**预热**要一致性校验,后者有干净的解,见 §5.3.3);② plan 工具强依赖;③ 完整 KV-cache 经济学(前提不成立,见 §1.3)。

### 2.4 magpie Long conversations——借鉴与取舍

magpie(yetone/magpie,Go,本地模型网关)不做内容级压缩,做的是:per-model > provider `"*"` > per-agent > global 的**压缩阈值分层配置**、用户手写配置 **held/让位**原则(命名保留、绝不静默覆盖)、**回放调参**(Tuned for you:重放历史请求按 token 加权选阈值,≥3 次带计时压缩后计入等待时长)、压缩**指标埋点**(compact_boundary/durationMs)、feature-detect 后再写配置的版本兼容模式。

**借鉴**:① 分层配置模型(→ settings 设计);② 让位原则(→ 与 pi 原生 `compaction.*` 设置共存);③ 埋点(→ 遥测);④ 能力探测后启用。
**不借鉴**:配置文件改写注入(我们是 extension API 直连,无需迂回);其"背景压缩"是 Codex 宿主功能,不可移植。

---

## 3. 需求 → 机制映射

| 用户需求 | 机制 | 来源 |
|---|---|---|
| 压缩无需等待(并行,与正常 thread 并行) | **Shadow 预计算**:idle/run 期间 side-channel 预先算好摘要,原生触发时 `session_before_compact` 直接回填 | pi seam 2.1-①;side-channel 先例 2.2 |
| 合理边界点、高效信息留存 | **智能切点**:理想 token 切点向自然结构边界(turn 起点/工具簇边界)对齐 | OCC 结构边界思想 + 原生 `findCutPoint` 升级 |
| 无感 | 回填路径剩余耗时 < 1s(无 LLM 调用);预热本身安排在 idle 窗口 | 本方案 |
| 高性能 | 预热时机 = token 增速外推的 horizon 决策,避免无效预热花钱 | OCC horizon 外推(magpie 埋点供调参) |

---

## 4. Design it twice — 三候选

### 候选 A:Shadow Precompute + 回填(✅ 推荐)

预热摘要(side-channel)+ `session_before_compact` 回填。原生触发器**保留**(threshold/overflow/manual 照常发出),只是内容已备好,LLM 调用被跳过。

### 候选 B:Draft 直落全接管

不等原生触发:自己在 turn_end 决策,用 `CompactionEntryDraft`(turn_end/agent_before_settle boundary 返回,`_applyBoundaryDrafts` 直接 `appendCompaction`)落盘,并 cancel 原生 threshold 压缩。

### 候选 C:OCC 移植(ctx.compact 串行 + 经济学)

SoL-Pi OCC 原样移植:聪明时机 + 结构边界,压缩仍走 `ctx.compact()` 串行执行。

### 对比

| 维度 | A Shadow+回填 | B Draft 全接管 | C OCC 移植 |
|---|---|---|---|
| G1 无感(等待→0) | ✅ 回填即 0 | ✅ 落盘即 0 | ❌ 仍是串行摘要等待 |
| G2 边界质量 | ✅ 切点自选(回填时锁定) | ✅ 完全自主 | ✅ plan 边界 |
| 风险/复杂度 | **低**:失败即回退原生,UI/事件链路全走原生 | 高:重造 overflow recovery/事件/UI 链路;draft 路径的 TUI compaction 行触发链路未证实;OCC 自己都弃 draft 选 `ctx.compact` | 中:但 plan 依赖不成立,需降级为启发式 |
| 与原生交互 | 最小(一个 hook 返回值) | 大(取消原生 + 自管全部) | 中 |
| 回退安全 | ✅ 永远原生兜底 | ❌ 接管后无兜底 | ✅ 原生兜底 |
| 并发额度影响 | 可控(idle 预热默认) | 无 | 无 |

**裁决:候选 A 为主体**,吸收 C 的 horizon 外推(→ §5.3.1)与保留清单 prompt(→ §5.3.2)、magpie 的分层配置/让位/埋点(→ §8/§10)。B 被弃的核心原因:接管原生触发器后,overflow recovery(`willRetry` + `agent.continue()`)、TUI compaction 行、压缩队列 flush 等行为都要自管并自行追平 pi 版本演进,收益与 A 相同但爆炸半径大一个量级。

---

## 5. 推荐架构(候选 A)

### 5.1 模块与 interface(codebase-design 语言)

新增深模块 `extensions/compaction/`,**外部 interface 极小**:

```
extensions/compaction/
├── index.ts        # factory: createCompactionExtension(pi) — 唯一外部入口
├── trigger.ts      # 预热时机决策(纯函数:token 序列 + 设置 → Decision)
├── cutpoint.ts     # 智能切点对齐(纯函数:entries + idealCut → CutPoint)
├── shadow.ts       # 预计算状态机(核心,单飞、可作废、可过期)
├── verify.ts       # 回填一致性校验(纯函数:PrecomputedSnapshot + event → Verdict)
├── llm.ts          # 摘要调用封装(pi compact() 顶层导出 + registry 鉴权)
├── telemetry.ts    # 埋点(custom entry 外置)
└── tests/          # node:test
```

Interface 全集(调用方需要知道的全部):

1. `createCompactionExtension(pi): void` —— 进 `moduleFactories`(注册位置:modes 之后、observation-pack 之前;不占 context 槽,顺序无强约束,但须在 memory 之后注册以便与 staging 共存调试)。
2. settings 键 `compaction.precompute.*`(§8)。
3. bus channel `compaction`(§9)。
4. 事件行为契约(不变量):本扩展**只**在 `session_before_compact` 返回值中表达自己;不 cancel、不 append、不触发改写 context。

Implementation 内部的 internal seam:`llm.ts` 可注入 fake(测试),`shadow.ts` 时钟可注入。**Interface 是测试面**:trigger/cutpoint/verify 全部纯函数直接测,shadow 状态机注入 llm/时钟测,不需要 mock pi runtime。

### 5.2 数据流

```
                    ┌────────────────────────────────────────────┐
   agent run        │  turn_end / agent_settled / message_end    │
      │             └──────────────┬─────────────────────────────┘
      │  正常对话继续                ▼
      │                       trigger.ts: getContextUsage + 外推
      │                             │ horizon ≤ 提前量?
      │                     ┌───────┴────────┐
      │                     ▼ 否: 无操作      ▼ 是: 启动预计算(side-channel,与主线程并行)
      │                                  shadow.ts: computing
      │                                  ├─ prepareCompaction(可能换智能切点 §6)
      │                                  ├─ llm.ts: pi compact(preparation, model, …)
      │                                  └─ 快照 {leafId, cutEntryId, prevSummaryEpoch,
      │                                     summary, usage, tokensBefore, fileOps} → ready(带 TTL)
      │                                      │
      ▼ 用户继续对话(切点后新增消息,不影响快照)│
                                              ▼
              pi 原生触发(threshold / overflow / manual)
                              │ emit session_before_compact
                              ▼
                     verify.ts: 一致性校验(§5.3.3)
                    ┌─────────┴─────────┐
                    ▼ PASS               ▼ MISS
          返回 {compaction: 快照}      返回 undefined(原生路径兜底)
                    │                    │
                    ▼                    ▼
        appendCompaction(原生流程, 0 次 LLM 调用)   原生摘要 LLM 调用(等待)
                    │
                    ▼
        session_compact → compaction_end → cctui 行(照常)→ goal RESYNC / memory 去重(照常)
```

### 5.3 关键机制

#### 5.3.1 预热时机决策(trigger.ts)

**Phase 1(朴素)**:预热线 = `contextWindow - reserveTokens - leadMarginTokens`(默认 `leadMarginTokens = 30_000`,约一个中型 turn 的两倍)。`turn_end` 时 `getContextUsage().tokens ≥ 预热线` → 启动预计算(idle 窗口:run 已结束、用户尚未发下一条,不与主请求抢 GLM 并发档位)。

**Phase 3(外推)**:按最近 N turn 的 token 增速估算「到达原生阈值还剩几个 turn」(`horizonTurns`);`horizonTurns ≤ warmupHorizon`(默认 2)时预热。同时守门:
- 预热调用成本 ≈ 摘要输入 tokens(可从 preparation 精确得出)× side-channel 模型单价;
- 命中概率 = 会话继续推进概率(简单启发:最近 10min 有用户输入则视为活跃);
- 成本 > 阈值或会话不活跃 → defer(决策原因枚举落 telemetry,学 OCC 的 `deferred_*` 词汇表)。
- **epoch 重置**(OCC):用户 steer 大幅改向(检测:连续用户输入不含 agent 产物引用,启发式)或 session reload → 清空预热状态与统计,防止过期 horizon 污染。

**默认不与 agent run 并发**(用户 GLM Coding Plan 有并发档位约束);`compaction.precompute.aggressive: true` 才允许 run 中并行预热(OQ2 附带)。

#### 5.3.2 预计算执行(shadow.ts + llm.ts)

1. 取 `branchEntries`(从 `ctx.sessionManager` 投影,goal/observation 同款读取方式);
2. `prepareCompaction(pathEntries, settings)` 得到原生 preparation;若启用智能切点(Phase 2),重切后**重建 preparation**(§6);
3. 调 **pi 顶层导出的 `compact(preparation, model, apiKey, headers, customInstructions?, signal, …)`**:
   - prompt、split-turn 双摘要、retry 策略、fileOps、`estimatedTokensAfter` 全部与原生同构 → G3 等价性的根;
   - model:解析链 `compaction.precompute.model > 会话当前模型`(§8);鉴权 `registry.getApiKeyAndHeaders(model)`(memory/llm.ts:44-49 同款,含 credential-rotation 重试由 pi retryAssistantCall 内建);
   - signal:AbortController,session_shutdown / reload / 手动压缩 miss 时取消;
   - **customInstructions 增强**(OCC ProgressSummary 思想):在原生指令基础上追加一段结构化保留清单要求(保留已验证的事实、文件清单、未决决策、下一步;精确文件路径与错误信息)——仅当用户未自带 `/compact args` 时;
4. 成功 → 快照入 `ready`(TTL:无限,jsonl append-only 保证输入不过期,只有一致性校验能判废);失败 → 记 telemetry,指数退避重试 1 次,再失败置 `degraded`(不再预热,直到下次 epoch),原生兜底。

**状态机**:`idle → computing → ready → (applied | stale | cancelled)`,同一时刻至多一个 in-flight;`computing` 期间再次满足触发条件不重复发起。

#### 5.3.3 一致性校验与回填(verify.ts)——本方案的安全核心

`session_before_compact` handler 收到 event 时,快照 PASS 需同时满足:

| # | 校验 | 防什么 | 失败动作 |
|---|------|--------|----------|
| V1 | 快照 `cutEntryId` 存在于 `event.branchEntries` 从 root 到当前 leaf 的路径上,且**该前缀(切点之前的所有 entry id 序列)与预计算时完全一致** | session 分叉(`session_tree`/fork)/手改 jsonl → 摘要输入漂移 | MISS → 原生 |
| V2 | 快照 `prevSummaryEpoch`(预计算时的最后一条 compaction entry id)仍是当前路径上最后一条 compaction | 中间发生过原生压缩 → previousSummary 迭代链断裂 | MISS → 原生 |
| V3 | token 安全:估算压缩后 context = `estimateTokens(summary) + Σ estimateTokens([cutEntryId..leaf])` < `contextWindow - reserveTokens` | 预热后用户狂聊,保留段超预算,压完仍溢出 | MISS → 原生(原生切点更靠后,天然安全) |
| V4 | `reason` ∈ {threshold, overflow, manual}(全部接受)且非 `event.signal.aborted` | — | MISS → 原生 |

**为什么 V1 对线性追加天然成立(并行无感的根基)**:jsonl 是 append-only 树,摘要输入 = `[上次压缩边界, 切点)` 的消息,全部在**切点之前**;预计算之后的新消息只能 append 在尾部(切点之后、保留区内),不可能改变被摘要区间。因此"预计算与实际触发之间用户继续对话"**不是**失配来源——这正是「与正常 thread 并行」在数据模型上成立的原因。只有分叉/再次压缩/超预算三种真实失配,分别由 V1–V3 覆盖。

回填:PASS → 返回 `{compaction: {summary, firstKeptEntryId: cutEntryId, tokensBefore: 回填时刻重算, usage, details}}`(`tokensBefore` 是显示语义("Compacted from N tokens"),须反映回填时刻的真实 context 而非预热时刻——用 `event.preparation.tokensBefore` 或 `ctx.getContextUsage()` 现算,不用快照旧值)。原生后续 `appendCompaction` + 投影刷新 + 事件链**全部照走**(`agent-session.js:2286-2306` 实证:fromExtension=true,无 LLM 调用)。cctui 的 compaction 行、goal RESYNC、memory RV-06、modes 缓存失效零改动继续工作。

`reason=manual` 特别处理:用户 `/compact` 瞬间若快照 `ready` 且 PASS → 秒回;`computing` 中 → 取消预热(结果必然过期不了多少,但手动压缩用户在等,原生直接跑更快),MISS;`customInstructions` 存在且非空 → 快照摘要不含该 focus,MISS(除非 Phase 2+ 做「快照 + 追加指令的增量更新」,列为 OQ)。

#### 5.3.4 失败与回退矩阵

| 场景 | 行为 | 用户感知 |
|---|---|---|
| 预热 LLM 失败/超时 | 退避重试 1 次 → degraded,原生兜底 | 无感(看到的就是原生压缩) |
| 回填 MISS(V1–V4) | 原生路径 | 无感(原生压缩) |
| 回填 PASS | < 1s 完成 | compaction 行一闪,"instant"(Phase 4 呈现) |
| overflow(预热没来得及) | 原生路径(溢出恢复时序敏感,不冒险) | 原生行为 |
| session shutdown/reload | 取消在飞预热,状态丢弃 | 无 |
| pi 版本不满足 | 扩展自禁用(§11) | footer 一行提示,原生行为 |

**不存在任何「既没回填成功、又没走原生」的分支**——回填是纯加法,G3 由结构保证。

---

## 6. 智能切点设计(Phase 2)

### 6.1 动机

原生切点 = token 距离落点,两类损伤:① split turn(切在 turn 中间)→ 原生被迫双摘要,且 turn 语境被腰斩;② 切在工具簇中间 → 「读了一半文件后开始新上下文」式断裂。

### 6.2 算法(cutpoint.ts 纯函数)

```
alignCutPoint(entries, idealIndex, opts) → {cutIndex, boundaryKind}
  1. 候选集:从 idealIndex 向两侧窗口搜索(maxBackward/maxForward 容差,
     默认各 0.25 × keepRecentTokens 折算的条目跨度);
     候选 = 原生合法切点集合(isCutPointMessage 同集,不扩大合法集——G3 纪律)
  2. 边界类型识别:
     - TURN_START:user-role 消息条目且开始一个 turn(pi 注入消息的甄别在实施时
       核 SessionMessageEntry 的 meta 字段;保守版:any user entry,与原生同集只加偏好)
     - CLUSTER_END:assistant 条目且其 tool 簇(后续连续 toolResult)已闭合
  3. 评分:score = boundaryBonus(TURN_START=2, CLUSTER_END=1, 其他=0)
           − distancePenalty(|tokens(候选..ideal)| / keepRecentTokens)
     约束:保留窗口估算 tokens ∈ [0.75, 1.5] × keepRecentTokens(前置/后置都不越界)
  4. 取最高分;无候选 → 原生切点原样返回(零风险退化)
```

### 6.3 与 preparation 的衔接

切点改变后重建 `CompactionPreparation`:`firstKeptEntryId`、`messagesToSummarize`、`turnPrefixMessages`(对齐到 TURN_START 后 `isSplitTurn=false`,**顺带消灭 split-turn 双摘要的第二次 LLM 调用**)、`tokensBefore`、`fileOps` 全部按新切点重算(复用 pi 导出的 `estimateTokens`/`findTurnStartIndex`/文件操作提取工具,不重写)。重建结果同样走 pi `compact()` → 产物结构与原生同构,只是内容按我们的边界切。

### 6.4 明确不做

- plan-step 边界(§1.3);跨多次压缩的全局切点规划(每次压缩独立决策);把 observation-pack 的 handle 区段特殊对待(observation 投影发生在 context 层,与本切点层正交)。

---

## 7. 与其他模块/原生的仲裁

| 相邻方 | 关系 | 结论 |
|---|---|---|
| memory staging(`session_before_compact` ZERO-LLM) | 同事件多 handler,pi runner 顺序执行不互斥 | 零冲突;本扩展**不 cancel**,staging 照常 |
| memory RV-06 去重窗口 | 以 compactionSummary 条目为界 | 回填同样产生该条目,零改动 |
| goal RESYNC(`session_compact` → `before_agent_start` 重注入) | 下游消费者 | 零改动 |
| modes 缓存失效(`session_compact`) | 下游消费者 | 零改动 |
| observation-pack(`context` 投影,FINAL 槽) | 正交层(注入预算 vs 压缩切点) | 注册顺序不变 |
| pi 原生 threshold/overflow 触发器 | **保留**(回填的触发器就是它们) | 不 cancel 任何原生压缩(与 OCC 相反,OCC 要护边界名额,我们内容即名额) |
| cctui compaction 行/spinner | 回填走原生事件链 | 零改动;Phase 4 加 ready 状态呈现 |

---

## 8. 配置设计(host settings.json 命名空间 + 让位)

`~/.pi/agent/settings.json`(host 管理,只读认领,mode: memory/automation.ts:88-100):

```jsonc
{
  "compaction": {
    // —— pi 原生键(已存在,本扩展只读尊重,绝不写入)——
    "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000,
    // —— 本扩展新增子键(全部带默认,缺省即全开 Phase 1 行为)——
    "precompute": {
      "enabled": true,            // 总开关
      "model": undefined,         // 预热摘要模型;缺省 = 会话当前模型(OQ1)
      "leadMarginTokens": 30000,  // Phase 1 预热线提前量
      "warmupHorizonTurns": 2,    // Phase 3 外推提前量
      "aggressive": false,        // 允许与 agent run 并发预热(默认关,护并发额度)
      "cutAlignment": "turn"      // "none"(原生切点)| "turn"(智能切点,Phase 2)
    }
  }
}
```

**让位规则(magpie held 原则)**:检测到用户手写 `precompute.*` 键即视为用户主权,扩展按用户值运行并 telemetry 标注 `held:*`;与 pi 原生 `compaction.*` 键永不相碰(只增子对象,不覆盖兄弟标量)。per-model 分层覆盖(原生 `compaction.modelOverrides`)保持只读透传——预计算读原生 settings 时原生已合并好,OQ3 实施时核对 merge 语义。

---

## 9. bus channel 与 cctui(Phase 4)

bus v2 新增可选 channel(**不升协议版本**,bus.ts:54-56 先例):

```ts
interface CompactionPatch {
  state: "disabled" | "idle" | "computing" | "ready" | "applied" | "degraded";
  cutAligned?: boolean;          // 最近一次应用的切点是否结构对齐
  readyCutBoundary?: "turn" | "cluster" | "native";
  lastWaitMs?: number;           // 最近一次压缩用户感知等待(applied 路径应 <1000)
  lastSavingsMs?: number;        // 原生路径估算等待 − 实际等待
}
```

cctui 消费(shape-checked,旧 core 无此 channel 静默降级):
- `ready` 时:compaction 将至的轻量预告(样式 Phase 4 出 mockup 再定,遵循「形态级先出方案」惯例);
- `applied` 时:现有 compaction 行尾追加 `· instant (precomputed)` 徽标。

---

## 10. 遥测(telemetry.ts)

每次压缩(回填/原生/miss 各路径)记一条 session custom entry(不进 context,OCC 状态外置同款):

```
{kind:"cc-compaction-telemetry-v1", reason, precomputed: bool, missReason?: V1-V4,
 waitMs, summaryTokens, tokensBefore, tokensAfter, cutBoundary, horizonEstimate}
```

用途:① 验证 G1(waitMs 分布);② 调 `leadMarginTokens/warmupHorizonTurns`(magpie 回放调参的离线版原料,OQ4);③ miss 率监控(V1–V4 各自频率,异常升高 = pi 行为变化预警)。

---

## 11. 兼容与自禁用

- 版本 gate:`probePiCompat`(MIN_PI_VERSION 不变)之外,load-time **feature-detect**:验证 `session_before_compact` 事件存在 + pi 顶层 `prepareCompaction/compact` 可导入;任一不满足 → `assessEconomyModule` 式自禁用(console.warn + 首个 session_start footer 行),**不阻塞**主扩展链。
- `before_agent_start` union 变更教训(memory/index.ts:410-419):本扩展不消费该事件,不受影响;`session_before_compact` payload 若在未来版本变化,契约测试钉住(§12)先行红。
- 兼容范围:0.87.0 声称、1.5.0 实测(feature-detect 决定实际可用面;0.87 是否具备 compaction 替换语义实施首日验证,不具备则该版本自禁用,无功能损失)。

---

## 12. 测试策略

| 层 | 类型 | 内容 |
|---|---|---|
| trigger.ts | 红绿钉住 | 预热线触发/不触发;外推 horizon;epoch 重置;degraded 抑制 |
| cutpoint.ts | 红绿钉住 | TURN_START/CLUSTER_END 识别;容差越界回退原生切点;**永不切 toolResult**;保留窗口 [0.75,1.5] 约束 |
| verify.ts | 红绿钉住 | V1 线性追加=PASS(并行无感的关键钉子);V1 分叉=MISS;V2 中间压缩=MISS;V3 超预算=MISS;manual+customInstructions=MISS |
| shadow.ts | 状态机 | 单飞;computing 中再触发不重复;shutdown 取消;TTL/作废 |
| **等价性** | **契约测试** | 同一 branchEntries + 同一 fake LLM 响应:回填路径 CompactionEntry 与原生路径 CompactionEntry **逐字段同构**(summary/firstKeptEntryId/tokensBefore/usage/details);vitest.contracts 套件新增 |
| 端到端 | node:test | 模拟 jsonl 增长序列(预热→继续聊 3 turn→原生触发→回填 PASS)全链 fake LLM |
| 回归 | 手工 smoke | 真机 GLM:长会话推到阈值,观察回填路径 cctui 行 + goal RESYNC 正常 |

测试目录:`extensions/compaction/tests/`(node:test,入 `run-tests.mjs` 的 `nodeTestDirs`);契约测试入 `test/contracts/`。

---

## 13. 分期计划与爆炸半径

| Phase | 内容 | 半径 | 测试兜底 |
|---|---|---|---|
| **0** | spec 定稿(本文档)+ 契约测试骨架(等价性用例先行红) | 无代码 | — |
| **1** | MVP 无感:朴素预热线 + pi 原生切点 + 预计算(pi `compact()`)+ V1–V4 校验回填 + settings + 自禁用 gate + telemetry v1 | **纯性能**(回填不改产物语义,摘要同构) | 等价性契约 + verify 红绿 |
| **2** | 智能切点(cutpoint.ts + preparation 重建) | **功能影响**(压缩产物内容按新边界切) | cutpoint 红绿 + 等价性(切 none 档回归) |
| **3** | 外推决策 + epoch + aggressive 档 + 成本守门 | 纯性能(触发时机) | trigger 红绿 |
| **4** | cctui 呈现(ready 预告 + instant 徽标)+ 分层配置打磨 + 文档 | cctui 功能面 | cctui 侧测试 + mockup 审批 |

每 Phase 独立可发版、独立可回滚(开关 `precompute.enabled` / `cutAlignment: "none"` 一键退回原生行为)。

---

## 14. 风险清单

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R1 | pi 升级改变 `session_before_compact` 语义/compact 导出 | 中/高 | 契约测试钉住 + feature-detect 自禁用 + 只用公开面 |
| R2 | 预热浪费(用户 /clear、换模型、终止会话) | 中/低(一次调用成本) | shutdown 取消;TTL 外只受一致性校验保护;telemetry 统计浪费率 |
| R3 | GLM 并发档位被预热挤占 | 低/中(默认 idle 预热不并发) | aggressive 默认关;文档注明 |
| R4 | 换便宜预热模型导致摘要质量降级 | 用户自选/中 | 默认会话模型;文档明示权衡(OQ1) |
| R5 | chars/4 估算误差导致 V3 误判 | 低/低(与原生同源误差) | 沿用 pi estimateTokens;V3 留 10% 余量 |
| R6 | 手动 /compact 的 customInstructions 场景回退原生,用户期待秒回 | 低/低 | 文档说明;OQ5 增量更新 |
| R7 | 与未来 pi 原生「后台压缩」撞车 | 低/中(若官方实现,本扩展空转) | feature-detect 原生能力,检测到即自禁用让位(magpie held 精神) |

---

## 15. 验收标准

1. **G1**:真机 GLM 长会话,threshold 触发压缩时 cctui 无长 spinner,compaction 行 ≤1s 出现;telemetry `waitMs(applied) < 1000ms` 全样本成立。
2. **G3**:全部失败矩阵场景(预热失败/各 MISS/overflow)下行为与关闭扩展的原生 pi 逐项一致(等价性契约绿)。
3. 等价性契约测试:回填 CompactionEntry ≅ 原生 CompactionEntry(同 fake LLM)。
4. `cutAlignment: "none"` 且预热后无新消息的理想时序下,回填 CompactionEntry 与原生路径逐字段一致;有新消息时仅 firstKeptEntryId 按设计提前(保留段更大),summary 输入集不变(Phase 2 回归门)。
5. 开关关闭/版本不满足 → 零行为差异,footer 一行自禁用提示。
6. `pnpm test`(vitest + node:test + contracts)全绿,零 DEVIATIONS 增量。

---

## 16. Open Questions(实施前拍板)

- **OQ1** `precompute.model` 默认值:会话模型(质量零回归,只赚时间)vs 便宜模型(省钱,质量自担)——建议先会话模型,telemetry 积累后给切换建议。
- **OQ2** aggressive(run 中并行预热)档是否保留:GLM 并发档位实测后再定。
- **OQ3** pi `compaction.modelOverrides` 精确语义(reserve/keep per-model override vs 摘要模型)实施首日核对 settings-manager 源码。
- **OQ4** 回放调参(magpie Tuned-for-you 离线版):待 telemetry 数据量,Phase 3 后再议。
- **OQ5** manual `/compact args` 的预热快照增量更新(快照 + 追加 focus 的二次小调用):收益场景窄,默认 MISS 走原生,观察 R6 频率再议。

---

## 附录 A:关键 API 一手摘录

- `SessionBeforeCompactResult {cancel?: boolean; compaction?: CompactionResult}` — `pi-coding-agent/dist/core/extensions/types.d.ts:1155-1158`
- 回填采用点(summary/firstKeptEntryId/tokensBefore/usage/details 全取扩展值,跳过 `_runDefaultCompaction`)— `dist/core/agent-session.js:2286-2306`(manual 路径实测;auto 路径 2561-2593 同构)
- `CompactionResult {summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details?}` — `dist/core/compaction/compaction.d.ts:18-27`
- `prepareCompaction(pathEntries, settings) → CompactionPreparation | undefined`、`findCutPoint`、`findTurnStartIndex`、`shouldCompact`、`estimateTokens`、`compact(...)`、`generateSummaryWithUsage(...)` — 同文件,均为顶层可导入导出
- 原生阈值 `contextTokens > contextWindow − reserveTokens` — `dist/core/compaction/compaction.js:173-177`
- 合法切点集合与"绝不切 toolResult" — `dist/core/compaction/compaction.js:253-266`

## 附录 B:参考项目

- SoL-Pi OCC:https://github.com/NVlabs/SoL-Pi(`src/sol-pi/extensions/online-context-compact/`)
- magpie:https://github.com/yetone/magpie(`internal/codexcat/`、`internal/agent/*_compact*.go`、docs/subsystems/agent-wiring.md)
- pi 上游:https://github.com/earendil-works/pi
