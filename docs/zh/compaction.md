# Smart Compaction（extensions/compaction）

第 14 个 core 模块：接管式压缩控制器——后台与主对话并行预生成摘要，在
`turn_end`/`agent_before_settle` 边界以 draft 提议落盘，并以宿主分支记录对账确认
（`ready → proposed → committed`）。原生压缩保留为 overflow/阈值/手动兜底腿；控制器的
fallback 腿可在 `session_before_compact` 向原生路径供稿（预computed 或现场生成），
一切路径均受硬容量闸 V8a 约束。

完整设计见 `spec/2026-11-08-smart-compaction-takeover.md`（§5 需求表）。本页为机制摘要
与 W2 校准记录。

## 运行期插桩（SC-MET-01）

仅 `on` 模式新增独立 display-only entry `cc-core-compaction-metrics` v1：
compute-start/compute-ready/proposal/applied/fallback-start/fallback-end。
只记录时间、随机关联 id、token 压力与有效阈值、配置比例、阶段/降级状态和耗时；
不含对话、摘要正文、文件路径或凭据。`off`/`shadow` 不写此类 entry，
冻结的 ST-01 字段与压缩参数均不变。

在本仓库本地聚合会话文件（不调模型、不访问网络）：

```sh
pnpm exec tsx scripts/compaction-metrics.mjs ~/.pi/agent/sessions
```

JSON 报告包含预压耗时/提前 token 量的 p50/p90、触发 threshold 兜底时的阶段
（区分摘要还在计算与没有/无法应用快照），manual 与 overflow 单列。
`observedEarlyTakeoverRate` = 阈值前确认提交的 draft 数 /
（全部确认提交的 draft 数 + threshold 兜底尝试数）。被覆盖的提议不算提交，
压力未知不算成功；applied 保留提议时压力，避免压缩后 usage 为 null（H7）失真。
会话未结束/事件不完整、兜底失败仍通过计数可见；无样本返回 null，不伪报 100%。

这是**实际运行的接管指标，不等于回放的反事实 M1**：提前提交本身就阻止了原本
可能发生的阈值越界，无法直接观测回放分母。报告显式输出
`counterfactualM1Available:false`，不得据此宣称 >=90% 发布目标达成。
下文旧回放 0.52 的结果并未因加插桩而重新校准。

## 一页机制

- **边界时钟**：同一宿主边界只观察计数一次，随后的 apply-time `propose` 转移
  不再重复推进计数。不同的 `turn_end`、`agent_before_settle` 仍各计一次
  （含压力为 null 的观察）；冷却配置沿用既有的 boundary 单位。
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

默认：**`on`**——2026-11-10 用户显式批准（DEVIATIONS SC-1 恢复条件②），
属 user override 而非 gate 通过：回放事实保留（跨机合并 M1 = 39/50 = 0.78
未达 0.90 全样本目标，可行子集 92.9%；第二台机器语料已补）、真机 H-SC
待证据清单保留（SC-3）。自动降级不受影响；回滚一行
（`PI_CORE_COMPACTION=shadow`）。

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
原生阈值事件 23 个）。这是历史基线；第二台机器语料已于 2026-11-10 补入，
最新跨机结果与口径限制见本页末节。

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
   POL-09 判不可行，控制器正确不工作，R15）；3/23 发生在多次压缩会话、
   **未归因**——插桩 trace 显示其在中位数 T_n 代理下均为临界失误（预压未启动或
   P 未达提议线），与阈值估算误差相容，但 `tokensBefore` 是压缩点上下文量而非
   配置阈值，不能据此排除控制器/时序因素（2026-11-11 上线前审查修正措辞）。
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

## 跨机回放复测（2026-11-10）

同一修复工作区版本、相同默认参数和摘要耗时模型，仅更换输入语料；
离线运行，不调用真实模型、不改变参数或默认模式。原始会话只留在本地临时目录，
不入库、不输出正文。Air 只读取得 367 个 JSONL（391 052 581 bytes），
全部可解析；补拉一次后仍有 1 个活跃文件继续增长，快照比最终远端少
3 141 bytes，不宣称原子一致或覆盖后续追加内容。

| 语料口径 | JSONL / 可推导阈值的文件 | M1（默认固定比例） |
|---|---|---|
| 本机，沿用旧的逐文件口径 | 1 167 / 11 | 12/23 = 52.2% |
| Air，逐文件 | 367 / 12 | 29/29 = 100% |
| 跨机保守去重 | 1 487 / 21 | **39/50 = 78.0%** |

去重规则：折叠 44 个内容相同的文件；同一 session id 的追加前缀快照取最长版本
（折叠 1 个）；另有同 id、互非前缀的 2 个本机分叉文件，各含 1 次压缩，
从合并样本排除，避免把同会话分支当独立样本或任意择优。原始未去重合计为
41/52 = 78.8%，同样未达 90%；排除冲突后不是“新算法提升”，只是样本口径变化。
本机与 Air 均无坏 JSONL 行；部分日志无 session header，只能按内容哈希去重。

**分层诊断，不替代发布分母**：合并样本中，回放判为可行的 20 个文件是
39/42 = 92.9%；1 个推导 `T_n≈45.7K` 的会话贡献 8 次不可行事件。
其余 3 次未提前提交已逐事件诊断（instrumented simulateSession trace，
2026-11-10；2026-11-11 上线前审查修正归因措辞）：2 次发生在同一会话、
1 次在另一会话。插桩 trace 显示，按会话中位数 `T_n`（441K/446K）回放时，
三次都是临界失误——控制器要么还在 precompute 比例之下，要么快照 ready 但
P 未达 applyRatio 提议线，回放推导的阈值先到。这与中位数代理的估算误差
**相容**，但不是已证结论：`tokensBefore` 是压缩落盘时的上下文量、不是配置
阈值（压缩可能晚触发而远高于阈值），其跨度不能证明"真实阈值比中位数低
119K–229K"。根因未归因，**不能排除控制器或时序因素**——需真机
`cc-core-compaction-metrics` 的提议/丢弃原因码裁决。生产使用宿主当刻
有效阈值（H8），不存在中位数近似。
工具以历史 `tokensBefore` 中位数推导 `T_n`，固定 keep=20K，历史压缩触发原因
也未独立标注，因此这些是回放代理结果，不是已知真实窗口或线上接管率。
Air 推导阈值约 251.6K–643.6K，语料差异不能解释成 Air 的硬件更快。

| 方案（去重合并） | M1 | M10 白做率 |
|---|---|---|
| 固定比例（默认） | **78.0%** | 6.1% |
| 固定提前量 25K | 70.0% | 2.0% |
| 固定提前量 50K | 74.0% | 0.0% |
| 固定提前量 75K | 76.0% | 1.3% |
| 朴素速率自适应 | 78.0% | 33.7%（应用 V8b 通过率 68.2%） |

结论：第二台机器语料证据已补，默认固定比例保留；**全样本 M1 门槛仍未过**，
可行子集不作为替代分母，H-SC 真机验收与端点合规仍待补。
复现各源基线：`pnpm exec tsx scripts/compaction-replay.mjs <会话目录> --json`；
合并需使用上述去重后的输入，不能直接平均两机百分比。
