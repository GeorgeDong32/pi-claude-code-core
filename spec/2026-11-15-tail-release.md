# SPEC TR — 证据补完、H-SC-7 真实 run、P3 卫生批与 0.7.0 发版（2026-11-15）

来源：SR 批收尾后的候选清单（AskUser 确认）——A 真机补证据（S3 其余端点 + H-SC-6 严格腿）、B H-SC-7 真实 orchestrator run、C P3 卫生代码批（SR-1/SR-4/CH-6/CH-8 记档项）、D 发版 0.7.0。调查输入：两份 explorer 报告（bg-shell/run-tests 五项、modes/review/run-cmd 七项，2026-11-15）。

## 用户决策

- **D-TR-1**：范围 = A + B + C + D（发版 0.7.0）。
- **D-TR-2**：FX-2 上游提案本轮不做，仓库草稿原样不动（草稿复现第 3 步的不准确处只在汇报告知，不改文件）。
- **D-TR-3**：H-SC-7 主动构造；每场景最多重试 2 次，仍失败转被动收集（用户下次真实 rex-flow run 后事后裁决，台账写恢复条件）。
- **D-TR-4**：发版授权——C 合入、四门全绿、台账完成后：bump 0.7.0 → tag v0.7.0 → push main+tag → 双机安装。
- **D-TR-5**：真机用 rex 新 tab，被测会话 `CPA/glm/glm-5.3-flash`；真机缺陷只记录不修；原始证据 `~/.cache/pi-core-acceptance/2026-11-15-tr/`，仓库只收摘要（SC-3 先例）。

## 内定取舍（审批时已确认）

| 项 | 取舍 |
|---|---|
| SR-1a | `awaitTaskEnd` 把成员检查挪到 `refresh()` 之前（endSession 遗忘任务的 pid 不得进下一会话 emptyGroups） |
| SR-1b | `timeout` 非有限/≤0 前置拒绝，文案 "timeout is in seconds (not ms); must be a finite number above 0"，校验放最前（Infinity 得 finite 文案）；不改 schema 约束（保住 handler 文案）；现状 0/-5 被当普通读取，台账 SR-1 措辞随之更正 |
| CH-6① | 汇入 in-flight kill 加 `if (!task.notified)` 守卫（仿 E5 行），并发 TaskStop 一行 killed；注释同步 |
| CH-6② | 不改代码，只补特征测试（今日即绿）钉窗口 |
| CH-6③ | run-tests 空目录跳过并打印（现状：tsx 全仓 glob 把 vitest 也跑进来）；路径不可达不入库测试，worker 手工验证 |
| SR-4a | 只删接口成员与对象字面量项（内部函数有 3 处内部调用，保留）；类型级改动 |
| SR-4b | 合并为 plan.ts 导出 `isAssistantMessage`/`assistantMessageText`，函数体逐字照抄；与 compaction `textOf` 语义不同不合并；补 agent_end 带计划正文用例（现零覆盖） |
| SR-4c | 新增 adjudication-facts.test.ts：6–8 场景字面量 toEqual 钉原始 facts，不用快照；修正两处「parity golden 钉住」过度声称 |
| CH-8a | 超时回调外包 `setImmediate`（poll 阶段先递送 pending exit，再走 T2 分支）；与 deadline 真同时的窗口写头注释，不消除 |
| CH-8b | 武装从任意 agent_start 收窄为 directive 的 message_start（customType 以实际代码为准，worker 先核实）；docs/头注释/测试 harness 同步 |
| CH-8d | T1b/T2 孤儿 sleep：`echo $! >&2` + finally SIGKILL（时长不能缩短，会掩盖 drain 回归） |
| CH-8e | review 12 文件 + modes 3 文件补尾随换行，纯空白独立提交 |
| 不动项 | CH-8c（与 spec 一致）；SR-11（核实为设计内：H3 草稿提交不发 session_compact、走 seam，SM-02 覆盖）——两者只在台账更正说明 |

## C：P3 卫生代码批（3 路并行，各自 worktree @ spec commit）

所有行为修复先红后绿；纯重构只加钉测。细节按「内定取舍」表执行；红测落点：SR-1a/1b → task-output-wait.test.ts；CH-6① → status-entry.test.ts；SR-4b/4c → plan.test.ts / plan-flow.test.ts / 新增 adjudication-facts.test.ts；CH-8a/8b → run-cmd.test.ts / review-bus.test.ts。合入顺序 W-B → W-M → W-R（rebase + ff），main 跑四门，测试数只增不减。

## A：真机补证据（与 C 并行；沙盒 setup_env.sh 同款）

1. **S3-MiniMax**：`summaryModel: "CPA/Minimax/MiniMax-M3.1-Flash"` + `summaryMaxTokens: 8192`。判据：ST-01 applied/validated、摘要为正文非 reasoning-only、未截断。
2. **S3-GPT**：`summaryModel: "CPA/gpt-6.1-terra"`（报错则换 gpt-6* 其余）。判据同上。
3. **S3 OpenAI 兼容路径**：沙盒 models.json 加 provider `CPAO`（api=openai-completions，baseUrl=http://localhost:8317/v1），key 从 CPA 复制（仅沙盒内，绝不打印）；--print 预检；CPA 拒绝则记待证据。
4. **H-SC-6 严格腿**：沙盒加 `DEAD` provider 指向 127.0.0.1:9（必然持续失败）。判据：预压 refused/reason:"error"+冷却；兜底腿同败后原生主模型接手；FB-08 审计在案；会话不崩；status 显示原因码。

## B：H-SC-7 真实 orchestrator run（重，带兜底）

预检（任一失败先修沙盒；修不好转被动收集，D-TR-3）：rex CLI 在沙盒 HOME 可用（REX_SERVER/REX_SESSION 透传）；flow-* 写 $AG/.rex-flow（必要时 HOME=$AG 跑 install.sh）；rex-flow 五 skill 软链 $AG/.agents/skills；settings.packages 接受本地路径（worker pi 亦载 core，bypass 才可用）。

构造：临时目标仓 target/（目标=加 3 个小文件，C=1 串行 3 task）；planner/worker/GK 均为 rex tab 内 pi（GLM Flash）；orchestrator=被测会话（core 快照+TUI+probe，cwd=目标仓根，T_n=120K）；**不设 boardPath**（测自然关联，失败记缺陷）；另置诱饵 board（他项目开放 run r9）。

驱动：t1 merged、t2 doing 时，orchestrator 会话读仓外语料推过压缩线。

判据：摘要台账含真实 run id、开放 t2（及 t3 todo）、闭环 t1 仅一行、gate（如有）；诱饵零出现；压缩后 t2 merged 时 orchestrator 用正确 id 派出 t3，期间无重建上下文式重读（cat board.json/全量 show；协议内 `task list --run` 不算），由 probe tool_call 日志裁决。

## 台账与发版

1. 台账：DEVIATIONS 新增「SPEC TR」节 TR-1…n；更正 SR-1 措辞（≤0 实际被接受）；SR-11 改「设计内」；SC-3 按 A/B 结果收窄；CHANGELOG Unreleased（timeout 拒绝、TaskStop 去重、review 武装收窄、run-cmd 竞态）、PROGRESS、spec/README、docs/{en,zh}/compaction.md 真机节；沙盒 LEDGER.md 字段级记录含抽查。
2. 发版前冒烟：最终 main 快照沙盒跑一轮——后台 bash + `TaskOutput {block:true, timeout:5}`（E4 真机首测）+ `/smart-compact status`，扩展加载无错。
3. 0.7.0：CHANGELOG Unreleased → `## 0.7.0 (2026-11-15)`；package.json 0.7.0；commit `chore(release): 0.7.0`；tag v0.7.0（类型随 v0.6.0）；push origin main + tag；`zsh scripts/sync-deploy-copies.sh <release-hash>` 双机安装并核验 HEAD；提醒用户重启在跑的 pi 会话。
4. 收尾：删 tr-wt-* worktree 与分支、关全部场景 tab、汇报验收数字/发版 hash/剩余待证据。
