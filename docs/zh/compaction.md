# Smart Compaction（extensions/compaction）

第 14 个 core 模块：接管式压缩控制器——后台与主对话并行预生成摘要，在
`turn_end`/`agent_before_settle` 边界以 draft 提议落盘，并以宿主分支记录对账确认
（`ready → proposed → committed`）。原生压缩保留为 overflow/阈值/手动兜底腿；控制器的
fallback 腿可在 `session_before_compact` 向原生路径供稿（预computed 或现场生成），
一切路径均受硬容量闸 V8a 约束。

完整设计见 `spec/2026-11-08-smart-compaction-takeover.md`（§5 需求表）。本页为机制摘要
与 W2 校准记录。

## 一页机制

- **压力策略**（`policy.ts`）：`T_n = contextWindow − 有效 reserveTokens`，
  `P = tokens / T_n`；`preRatio` 预压、`applyRatio` 提议、POL-09 联合可行性先行。
- **切点**（`cutpoint.ts`）：容量优先窗口 `[keep, min(keep+slack, tailMax)]`，
  合法性复刻宿主规则，语义打分（user/idle-gap/plain-turn/tool-turn + W7/W8 信号）。
- **摘要器**（`summarizer.ts`）：pi 公开 `compact()` 经 `streamFn` 包装器——逐子调用
  分类/捕获、`maxTokens` 注入、关 reasoning、SUM-04 双层校验、一次硬化重试。
- **提议**（`apply.ts`）：V1–V10 前置校验（V10=避让不丢弃）、带对账 nonce 的 draft、
  分支扫描对账 → committed/lost、提交后冲突编辑审计。
- **台账**（`ledger/`）：确定性、落盘时重生成、12 000 字符预算 + 六级降级阶梯 +
  Tier A/B 自检。
- **兜底**（`fallback.ts`）：`session_before_compact` 供稿腿，单一总 deadline；
  原生摘要只审计（FB-08）不拦截。
- **seam**（`lib/compaction-seam.ts`）：goal/modes/memory 在 draft 路径每次确认提交
  恰好一次触发；原生路径走它们自己的 pi 事件。

配置：`~/.pi/agent/core-compaction.json`（ST-02）、环境变量
`PI_CORE_COMPACTION=off|shadow|on`、命令 `/compaction [status|mode …]`。
`shadow` = 完全被动：不预压、不提议、不供稿——仅保留 FB-08 原生摘要审计
（DEVIATIONS SC-5）。

**POL-07 提议闸（A1，2026-11-10 review 修复）**：draft 路径本身评估 apply-point
安全性——从边界 branch 读**最后一条 assistant** 的 stopReason（同时覆盖
`turn_end` 与 `agent_before_settle`）；`length` 边界永不提议，原生恢复不被吞。
**served 转移（A2）**：供稿腿供出快照后相位离开 `ready`（转 idle）——控制器重新
预压缩，而不是对已消费的 draft 复提议。**overridden 上界（A3）**：
lost(overridden) 复提议有上界——**会话内累计** `OVERRIDE_DEGRADE_AFTER = 2`
（state.ts 导出常量，与 conflictEditDegradeAfter 同族；commit 不清零，仅
session reset 清零）次 overridden 后降级 shadow；**每次** overridden 写
APP-08 discarded 遥测（`reason:"overridden"`）。

**Batch D 补强（2026-11-10 review）**：`off` 现在完全静默——FB-08 原生
摘要审计也关闭（G5 字节级一致；`shadow` 仍保留审计，SC-5）。台账继承
（LED-02b）与 run-id 提取只读上一轮摘要里**最后一个**完整 v1 块，且
compose 时 narrative 段先经标签中和——LLM 回显用户文本伪造的
`<cc-core-ledger>` 块不再遮蔽真台账（D4）。降级阶梯 ⑤ 的 goal 行 clamp
只钳 objective——id/status 等身份字段逐字保留（LED-01⑤，D5）。

## W2 回放校准记录（2026-11-09）

工具：`tsx scripts/compaction-replay.mjs <语料目录>… [--self-check] [--json]`
（仅输出聚合——INV-7）。语料：本机 pi 会话（1 166 个 jsonl；可推导阈值的会话 11 个、
原生阈值事件 23 个）。**第二台机器语料为待证据项**（本机不存在），恢复条件：在该机
运行同一命令补充记录。

| 指标 | 结果（固定比例默认值） | 说明 |
|---|---|---|
| M1 阈值前提交率 | **0.52**（12/23） | 校准目标 ≥ 0.90 在本样本未达——归因见下 |
| M2 切点合法率 | 1.00（构造保证，CUT-01 钉住） | |
| M3 尾部 ≥ keep | 0.65 | 压缩后小尾巴段的窗口回退所致 |
| M3b 容量 / 应用时 V8b | 1.00 / 1.00 | 容量优先选择在真实轨迹上成立 |
| M4 split 占比 | 0.10–0.30（各方案） | 低于原生——语义边界更多落在回合起点 |
| M6 原生阻塞 | 合计 ≈ 2 238 s / 23 次；p50 ≈ 103 s、p90 ≈ 171 s | 与 E1 的 53–171 s 带吻合 |
| M7 可行性覆盖 | 10/11 会话可行 | 1 个小窗口会话（T_n ≈ 45.7 K）按设计判不可行（R15） |
| M8 估算偏差 | p50 ≈ 0.52、p90 ≈ 0.59 | chars/4 与 usage 口径差——即下文校准因子的来源 |
| M9 回合增量 | p50 526 / p90 2 057 / p99 6 456 / max 26 623 tokens；>5 K：1.9%、>15 K：0.18%、>30 K：0 | burst 存在但远小于 25 K 提前量 |
| M10 白做率 | 0.18（固定比例）/ **0.00**（固定提前量 25k/50k/75k）/ 0.51（朴素自适应） | |

**O1/O2 三方案对比**（M1 / M3b / M10）：

| 方案 | M1 | M3b | M10 |
|---|---|---|---|
| 固定比例（默认） | 0.52 | 1.00 | 0.18 |
| 固定绝对提前量 25k | 0.52 | 1.00 | 0.00 |
| 固定绝对提前量 50k | 0.52 | 1.00 | 0.00 |
| 固定绝对提前量 75k | 0.52 | 1.00 | 0.00 |
| 速率自适应（朴素） | 0.52 | 1.00 | 0.51（V8b 0.50） |

结论：

1. **M1 的 11 次未预提交归因**：8/23 来自单个小窗口会话（T_n ≈ 45.7 K——默认参数下
   POL-09 判不可行，控制器正确不工作，R15）；3/23 来自多次压缩会话——按会话中位数
   近似 T_n 与逐回合 usage 采样看不到真实 modelOverrides 的有效设置，属回放工具的
   近似局限，非控制器缺陷。
2. **朴素速率自适应严格更差**（M10 0.51、V8b 0.50——早快照长大后过效率闸）。任何
   自适应方案必须与 POL-09 联合求解（spec O1 注记）。**默认保持固定比例**；固定
   提前量是本样本上唯一略优候选（M10 0.00）但 M1 无改善——O2 决策留给用户，
   未拍板前不改默认。
3. **口径校准**：持久化消息 chars/4 ≈ 宿主阈值所用 usage 的 22–40%（系统提示 +
   工具定义——即 POL-10 的 overhead）。回放按会话缩放切点视图的消息体量
   （`sessionCharScale`，中位数 ≈ 3.0）；生产无需该因子——V8a 的估算直接用
   `getContextUsage()` 校准。
4. **附录 C 默认值维持不变**，待第二台机器语料与用户 O2 拍板。

自检：`tsx scripts/compaction-replay.mjs --self-check`（同由
`test/lib/compaction-replay.test.ts` 钉住）。
