# FORK.md — extensions/goal fork 记录(P2-GO-01/06)

## 基线

| 项 | 值 |
|---|---|
| 上游 | https://github.com/capyup/pi-goal (MIT) |
| fork 基线 commit | `ec2bcbe` 「feat: split goal intent and direct set commands」(本地 pi-goal 检出 HEAD,2026-09-20 时点) |
| 对应发布版 | 上游 package.json `0.6.0`;**与 npm 已发布的 `@capyup/pi-goal@0.6.0` tarball 源码逐文件比对一致**(diff 实测 2026-09-21,唯一差异即下表白名单项) |
| fork 日期 | 2026-09-21(P2 实施日) |
| 上游 license | MIT(本仓库整体 MIT,兼容) |

## 版本线事实核查(纠正 handoff)

handoff 2026-09-20 称「npm 最新 0.1.7、本地领先」。**实测(registry.npmjs.org,2026-09-21):`@capyup/pi-goal` 版本线为 0.1.0–0.1.2 → 0.2.x → … → 0.5.0 → 0.6.0(最新),不存在 0.1.7。** 因此 P2 spec §8 的「0.1.7↔0.6.0 行为 diff 盘点」议题消解:npm 最新即 0.6.0,与 fork 基线同版本同内容,无需取舍。已同步 OPEN-QUESTIONS #3。

## 差异化清单(P2-GO-03 白名单内)

| 文件 | 差异 | 白名单依据 |
|---|---|---|
| `goal.ts` | +`publishGoalChannel()`(bus goal 通道:active/paused/summary),挂 `updateUI()` 开头;+coreBus/displayObjectiveTitle import;+`isSubagentChildProcess` import(modes/permission-forwarding)——`loadState` 子会话跳过磁盘收养、`reconcileFocusedGoalFromDisk` 同判定返回、`queueContinuation` 顶部早退(goal-hijack 修复,GH-02/02b/03,DEVIATIONS #71);`assistantTurnTokens()` 改为四通道求和(input/output/cacheRead/cacheWrite,上游仅前两项)——cache-inclusive 记账,开启 prompt caching 时上游口径会把真实用量低报约一个量级 | 用户指令 2026-10-01(DEVIATIONS #69);bus 通道形状零变化,仅数值口径 |
| `goal-accounting.ts` | core 新增文件(AR1005-GO-A,2026-10-05):活动时钟模块——段起点 + 每 goal 毫秒余数(carry),settle 不再每事件丢失亚秒碎片;注入式时钟 seam,生产单调时钟;落盘仍整数 activeSeconds(冻结格式,不加 carryMs 字段) | 上游无对应物;spec 2026-10-05 §7.2 |
| `goal-audit-flow.ts` | AR1005-AU-01(2026-10-05):封套顺序改为「内部取消结果 → 连接外部 signal → 检查当前状态」,预中止不调用 auditor;timer/双 listener 全路径释放 | 本树 B7 拆分文件(上游无对应物);spec 2026-10-05 §5 |
| `goal-auditor.ts` | config 读写迁 `lib/settings.ts`(readJson/writeJsonAtomic,写入获得 tmp+rename 原子性);pi 0.85 类型漂移修复(ResourceLoader 补 `getSystemPromptSource`/`getAppendSystemPromptSources`;`createAgentSession` 删 `modelRegistry` 选项——0.85 默认 modelRuntime 读同一 agentDir,auditor model 已显式解析为具体 Model);AR1005-AU-02(2026-10-05):session 全剩余生命周期 try/finally + `sessionAdapter` 测试 seam + 取消/异常路径恰好一次 dispose | P2-GO-03a;漂移修复是 fork 入树的必然(P0 时只读源包靠白名单豁免,入树后必须过 tsc);spec 2026-10-05 §5 |
| `goal-questionnaire.ts` | 对话框底座 `ctx.ui.custom(factory)` → `showComponentOverlay(ctx, {component})`(bare 调用、无 overlay options,行为等价) | P2-GO-03a |
| `ui.ts` | core 新增文件(DC4b 呈现解耦层)：状态栏/goal 块渲染经 `GoalUiDeps` 6-getter 参数化,上游无此文件 | DC4b(见 PROGRESS Core/UI 解耦批；上游无对应物) |
| `questionnaire-layout.ts` | core 新增文件(DC4b)：问卷布局表驱动化,上游无此文件 | DC4b(同上) |
| `tests/*.test.ts` | import 路径 `../extensions/ → ../`(布局扁平化) | P2-GO-03a(import 路径包内化;断言零改动) |

其余文件(`goal-core/goal-record/goal-files/goal-ledger/goal-policy/goal-pool/goal-draft/goal-compaction/goal-tool-names/goal-notifications/goal-widget/prompts/storage`)与 npm 0.6.0 **逐字节一致**。上游 `docs/` 与 README 未随迁(core 有自己的 README;上游文档按需参考源仓库)。

## 行为冻结面(实测钉住)

- 命令族 14 个(`goal` `goal-status` `goal-list` `goal-focus` `goal-settings` `goals` `sisyphus` `goals-set` `sisyphus-set` `goal-abort` `goal-pause` `goal-resume` `goal-tweak` `goal-clear`)签名不变(P2-GO-04)。
- 磁盘布局 `.pi/goals/active_goal_*.md`、`.pi/goals/archived/`、`.pi/goals/goal_events.jsonl` 不变(P0-CT-09 对 core fork 实测绿)。
- entry 类型 `pi-goal-state/-focus/-event/-audit-event` 不变(P0-CT-08)。
- 75 项随迁测试全绿(源包因缺 node_modules 仅能跑 66,core 内 0.85 依赖齐全后 75/75——多出的 9 项来自源包跑不了的 3 个 UI 测试文件,非新增)。

## 上游跟进策略(P2-GO-06)

> **结构性 fork 自持声明（arch B7，2026-10-02）**：core 侧重构批（B3 kind 字段化、B7 continuation/audit 模块拆分）之后，goal.ts 与上游 capyup/main 的文件映射已断裂——上游 bugfix 无法再干净 cherry-pick 到本树。自本批起放弃「逐字节一致」白名单维护，改为：上游 diff 仅作人工评估参考（同类 bug 在本树独立修复），不再执行机械 cherry-pick。

- 历史条款（0.2.0 前）：季度 diff capyup/main，仅 cherry-pick bugfix——随结构性 fork 自持声明失效。
- `.pi/goals/` 磁盘格式上游 break → 不再适用（无同步义务）；格式冻结由 P0-CT-09 契约测试独立保障。
- 行为回归仍由本树测试套件保障（goal 75+ 项 + 新增 continuation/audit-flow 直测）。
- cherry-pick 时同步跑 `bun run test`（goal 全量）与契约套件;behavior diff 进 PROGRESS。

## 与 core 的接缝

- goal 不直接读写其他模块状态;对外只经 status 槽 `goal`、widget `goal`、bus `goal` 通道(P2-BUS-01)。
- 与 modes 的 context 共存由 test/lib/coexistence.test.ts 钉住(P2-GO-05)。

## 2026-10-07 spec P0-2 — fully landed (D3=A confirmed 2026-10-08)

- **CORE-05 (landed 2026-10-07, 6f2a402)**: `startGoalDrafting`'s catch now
  resets `confirmationIntent` + `syncGoalTools()` (symmetric with the tweak
  path) — a failed draft start no longer strands the drafting tool gate.
- **D3=A + G3 (landed 2026-10-08, same batch)**: the non-progress mis-lock
  else-branch in the `tool_call` handler is deleted — only the four real stop
  tools' successful execute sets `turnStoppedFor`; every other tool call is
  progress-neutral. The progress-exception read changed from the nonexistent
  `event.args` to the host's real `event.input`, activating the dead
  echo / `.pi/goals` read exceptions. Both changes ship and revert as one
  unit (spec §7). Tests: `goal-turn-lock.test.ts` L1-L5/L7 (L1/L2/L5 red on
  the pre-change tree, L3/L4/L7 pin preserved behavior; the approved-audit
  path drives goal.ts through the same `auditor` parameter seam the audit
  flow already exposes).
