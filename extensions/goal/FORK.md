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
| `goal-auditor.ts` | config 读写迁 `lib/settings.ts`(readJson/writeJsonAtomic,写入获得 tmp+rename 原子性);pi 0.85 类型漂移修复(ResourceLoader 补 `getSystemPromptSource`/`getAppendSystemPromptSources`;`createAgentSession` 删 `modelRegistry` 选项——0.85 默认 modelRuntime 读同一 agentDir,auditor model 已显式解析为具体 Model) | P2-GO-03a;漂移修复是 fork 入树的必然(P0 时只读源包靠白名单豁免,入树后必须过 tsc) |
| `goal-questionnaire.ts` | 对话框底座 `ctx.ui.custom(factory)` → `showComponentOverlay(ctx, {component})`(bare 调用、无 overlay options,行为等价) | P2-GO-03a |
| `tests/*.test.ts` | import 路径 `../extensions/ → ../`(布局扁平化) | P2-GO-03a(import 路径包内化;断言零改动) |

其余文件(`goal-core/goal-record/goal-files/goal-ledger/goal-policy/goal-pool/goal-draft/goal-compaction/goal-tool-names/goal-notifications/goal-widget/prompts/storage`)与 npm 0.6.0 **逐字节一致**。上游 `docs/` 与 README 未随迁(core 有自己的 README;上游文档按需参考源仓库)。

## 行为冻结面(实测钉住)

- 命令族 14 个(`goal` `goal-status` `goal-list` `goal-focus` `goal-settings` `goals` `sisyphus` `goals-set` `sisyphus-set` `goal-abort` `goal-pause` `goal-resume` `goal-tweak` `goal-clear`)签名不变(P2-GO-04)。
- 磁盘布局 `.pi/goals/active_goal_*.md`、`.pi/goals/archived/`、`.pi/goals/goal_events.jsonl` 不变(P0-CT-09 对 core fork 实测绿)。
- entry 类型 `pi-goal-state/-focus/-event/-audit-event` 不变(P0-CT-08)。
- 75 项随迁测试全绿(源包因缺 node_modules 仅能跑 66,core 内 0.85 依赖齐全后 75/75——多出的 9 项来自源包跑不了的 3 个 UI 测试文件,非新增)。

## 上游跟进策略(P2-GO-06)

- 季度 diff `capyup/main` vs fork 基线:仅 cherry-pick bugfix(不带 feature)。
- `.pi/goals/` 磁盘格式上游 break → **停止跟进**(not-doing 续期),fork 自持。
- cherry-pick 时同步跑 `bun run test`(goal 75)与契约套件;behavior diff 进 PROGRESS。

## 与 core 的接缝

- goal 不直接读写其他模块状态;对外只经 status 槽 `goal`、widget `goal`、bus `goal` 通道(P2-BUS-01)。
- 与 modes 的 context 共存由 test/lib/coexistence.test.ts 钉住(P2-GO-05)。
