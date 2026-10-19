# Pi 插件熵控制改造方案（2026-10-19 · 修订版 · 含执行者复核）

> 状态：已确认，作为三个 goal 的执行规格。执行顺序 G1 → G2 → G3 严格串行（都改 guard/index.ts）。
> 本文为权威版：方案原文（修订版）+ 执行者五点复核 + 4 个微调项 + 2 个实现时落档项。
> 英文版：[entropy-control-spec.md](../en/entropy-control-spec.md)

## 摘要

取证报告表明，熵主要长在三处：memory 的写入与整理（无版本历史、错层、静默失效）、agent 能修改自己的权限与规则、auditor 的边界依赖 prompt 自律。goal 流程本身运转良好：20 个 goal 中 4 个经历过一次驳回后通过，没有一个因 audit 循环失控。

## 对先前假设的两处更正

1. **consolidate 由主模型执行，不是小模型。** 它是注入当前会话的 directive，主模型读完全部文件后调用 memory_consolidate；小模型只是 recall 的 selector。触发已经是阈值式（预算、文件数、每会话最多 2 次、间隔至少 10 个 turn）。风险是「主模型现场读几十个文件，成本高、污染上下文，且没有 diff 级校验」。
2. **audit 缺少确定性证据的问题没有预想的严重。** auditor 会自己重跑测试，真实失败模式是枚举交付物漏项。audit 补小点即可。

## 核实结论（执行者 12 项实测）

- **成立**：auditor 会话 `extensions: []`（goal-auditor.ts:183），permission-modes 规则不在其中生效；memory 无 git、age 纯 mtime（memdir.ts:255 排序即 mtimeMs）、consolidate 重写重置 age；guard 只校验 memory_consolidate 时 write/edit 直接操作可绕过（guard.ts:43 已按 write/edit 分流但仅 secret 探测）；10-03 写错目录机制仍在；`PI_SUBAGENT_CHILD` 在 memory 模块零消费；waitMs=0 parked（memory/index.ts:15 注释）。
- **需修正**：规则模型不支持 Write/Edit 路径 pattern（rule-families 只有 mcp-gov/web-gov），「加 ask 规则」= 新建 rule family，改走 guard 通道。
- **未证实**：consolidate reason 双打印（grep 单处消费），复现后再说。

## 执行者复核（Preflight 结论，2026-10-19）

### Goal 1 Preflight

- **P1 ✅（优于方案假设）**：guard 已在拦 write/edit——`extensions/memory/index.ts:355-368` tool_call handler 返回 `{block, reason}`；`extensions/memory/guard.ts:43` 按 toolName 分流。edit 应用后结果由 guard 读原文件 + 逐条应用 `edits[].oldText→newText` 模拟。
- **P2 ✅**：`memdir.ts:60 splitFrontmatter`（失败返回 null）= 索引判定源（memdir.ts:112 消费同函数），复用零循环依赖。跳过规则以 `isMemoryFile`（memdir.ts:45-51 `listMemoryFiles`）为准。
- **P3 ✅**：`memoryDir(ctx)` / `userMemoryDir(ctx)` / `gitCanonicalRoot(cwd)`（paths.ts:50，已 memoize）。
- **P4 ✅**：`process.env.PI_SUBAGENT_CHILD`。
- **P5 ✅**：ObservationPack `THRESHOLD_BYTES = 10*1024`（observation-pack/observation.ts:15，已 export）；then_run 识别见 action-fusion/index.ts（schema 自检 :128-135，融合执行体行号实现时落档）。

### Goal 2 Preflight

- **P1 ✅**：schema `{writes: ConsolidateWrite[], deletes: string[], reason?}`（consolidate.ts:88-89）；guard 校验链 = runConsolidation 的 fail() 序列（:97-106）。
- **P2 ✅（天然隔离）**：`listMemoryFiles` 非递归——sidecar 在 memory 目录外必不被扫。
- **P3 ✅**：age 唯一源 = recall.ts:144-147（mtimeMs→ageDays→`[N days ago — verify…]`）。
- **P4 ✅**：memory 已挂 session_start（index.ts:226）与 agent_end。
- **P5 ✅（实现时测试钉住）**：splitFrontmatter 解析固定字段集，未知字段宽容；G2 第一个测试 =「带 created 的文件可被 eligibleMemories 收录」。

### Goal 3 Preflight

- **P1 ⚠️ 半成立**：auditAttempts 计数 = goal.ts:1470-1471；「300 字符截断」精确位置实现时定位落档。
- **P2 ✅**：[Cn] 为新约定，goal prompt + 解析器新增；「objective 无编号 criteria 不提醒」兜底。
- **P3 ✅ 不阻塞**：details v1 含 delivery/elapsedMs；样本数由聚合脚本自报告。

### 微调项（并入执行）

1. **C1 同源判定**：guard 判定直接调 `splitFrontmatter + isMemoryFile`；测试断言「guard 放行 ⇒ eligibleMemories 收录」。
2. **C11 deletes 联合类型**：`deletes` 接受 `string | {file, reason}`，旧形状零迁移。
3. **C7 升级文档落点**：AGENTS.md 命令表 + docs/en+zh 各一小节。
4. **C20 提醒通道**：`sendMessage({deliverAs:"followUp", triggerTurn:false})`，audit 照常启动。

### 实现时落档项

- G3-P1：回灌 300 字符截断的精确 file:line。
- G1-P5：action-fusion then_run 融合执行体 file:line。

### 遗漏约束（复核补充）

1. **guard 与 permission mode 正交**：bypass 不豁免 guard（事件拦截器语义），落 docs。
2. **子会话钩子**：子代理是否触发 session_start/agent_end 未定——快照/后置检查设计为幂等；C6 禁写只靠 env。
3. **快照启动耗时**：两层 ~100KB 量级同步复制+哈希 <5ms，fail-open 必须有。
4. **C5/C14 直读文件**：不走 memdir 缓存（缓存 mtime 粒度会漏内容级变化）。
5. **automation ops 写路径**（不经 write/edit 工具）不在 G1 覆盖内，由 store 自身保证（进边界条款）。

---

## Goal 1：memory 写入守卫与自改保护

**Objective**：在现有 tool_call guard 通道内，让已发生过的三类 memory 写入事故，以及 agent 修改自身权限与规则配置的行为，在写入当下被确定性拦截并给出可执行的纠正提示；同时加上子会话禁写与升级金丝雀。不新建 rule family，不改动 consolidate。

### Success criteria

1. **[C1] frontmatter 校验**：写/编辑 memory 目录内 .md，结果被索引同源判定判为不可索引（无 frontmatter、缺必填字段、字段值非法）时 block，原因点出具体问题；索引扫描本来就跳过的文件不在校验范围。测试：三种情形各一拦 + 合法放行 + 跳过文件放行 + guard 放行 ⇒ eligibleMemories 收录。
2. **[C2] 写错目录**：路径在两层 memory 目录外、匹配 `**/memory/*.md`、内容带 memory frontmatter（name+description）时 block，提示给出两个正确目录绝对路径。测试：复现 10-03 场景（仓库根 memory/x.md）被拦；同路径普通文档放行。
3. **[C3] USER 层错层**：写 USER 层内容含当前 git root 绝对路径（含 `~/` 写法）且 frontmatter 无 `paths:` 时 block；仅含短仓名不拦只 warn 一次。测试：三组。
4. **[C4] 自改保护**：write/edit 目标属受保护路径（permission-modes.json、全局与项目 rules 目录、settings 文件；清单写死代码、独立文件、与 memory 守卫分离）时 block，文案告知用编辑器手动修改。测试：每路径一拦 + 插件源码仓写入放行。bypass 不豁免（落 docs）。
5. **[C5] 旁路检测**：session_start 记录受保护文件 sha256 基线（直接读文件），agent_end 重算，不一致 UI 提示一次（不 block）。测试：fs 直写 → 提示；无改动 → 无提示。
6. **[C6] 子会话禁写**：`PI_SUBAGENT_CHILD=1` 时两层 memory 目录写入一律 block，提示回传主 agent。测试：设/不设两组。
7. **[C7] 升级金丝雀**：构造超 THRESHOLD_BYTES（import 常量）的 tool result 断言占位符出现；构造 then_run 调用断言识别融合；失败信息指出失效机制。AGENTS.md + docs/en+zh 写明升 Pi 前先跑。
8. **[C8] 三门禁全绿**。

**Out of scope**：新建 rule family 或改 permission-modes 规则语义；解析 bash 命令；改 consolidate、快照、auditor、goal 流程；改 recall 算法或子会话 recall 行为；reason 文案改动。

## Goal 2：memory 快照与 consolidate 去向、年龄

**Objective**：为两层 memory 提供与写入路径无关的回滚点，让 consolidate 的删除可追溯，合并后的文件不再重置事实年龄。不引入 git。

### Success criteria

1. **[C9] 快照**：session_start 全量快照到目录外 sidecar（fail-open）；与最近一份哈希相同跳过；保留 10 份（具名常量）轮转。测试：首启 1 份 / 无变更仍 1 份 / 改动后 2 份 / 第 11 份淘汰最旧。
2. **[C10] 快照隔离**：快照内合法 frontmatter 文件不出现在索引与 recall。
3. **[C11] 去向校验**：memory_consolidate 每个被删文件必须出现在某 write 的 `merged_from` 或带逐文件 reason（`deletes: string | {file, reason}` 联合类型，旧形状零迁移），否则整次拒绝并列出缺去向文件名。测试：三组。
4. **[C12] created 保留**：产物带 `created`（merged_from 来源最旧 created 或 mtime；无 merged_from 取被覆盖同名文件；都无不写）+ `consolidated_at`（ISO）。测试：合并 60 天前 + 10 天前两文件 → created 为 60 天前。
5. **[C13] 统一 age**：有 created 且 mtime ≤ consolidated_at（容差数秒）取 created，否则 mtime；旧文件回退 mtime；manifest 显示与过期提示（recall.ts:144 换线）共用一个函数；排序仍按 mtime。测试：三分支各一 + 旧行为回归。
6. **[C14] 后置检查**：agent_end 与本会话 session_start 快照对比，未调 memory_consolidate 却 ≥3 文件被删或字节降 ≥30% 时 UI 提示一次（不 block 不回滚）。测试：fs 删 3 文件 → 提示；正常 consolidate → 不提示。
7. **[C15] 回滚文档**：docs 双语含从快照恢复的具体命令。
8. **[C16] 三门禁全绿**；must-shrink / frontmatter / secret 现有不变量行为不变。

**Out of scope**：引入 git；改 consolidate 触发阈值或指令文案；改 recall；改排序；自动回滚；为旧文件批量补 created。

## Goal 3：audit 轻量改进与 recall 数据聚合

**Objective**：让 audit 的结论回灌更可靠，对「漏项」给出不阻断的提醒，auditor 权限现状落档，用现有转录离线得出 recall 延迟数据。不改 audit 判定逻辑，不改 waitMs 默认值。

### Success criteria

1. **[C17] 权限现状落档**：docs 记录 auditor 会话 `extensions: []`（goal-auditor.ts:183）→ permission-modes 规则不生效；残余风险 = auditor 有未受规则约束的 bash；暂缓只读 profile 原因（跑测试需写 tmp）。含 file:line。
2. **[C18] BLOCKERS 格式**：audit prompt 要求报告末尾输出固定格式区块（`- [Bn] 一句话` ≤120 字；无问题 `- (none)`）。解析器对合规/空/缺失三类各有测试。
3. **[C19] 回灌用清单**：持久回灌优先用解析出的 BLOCKERS，逐条完整、超限按条截断标注「另有 k 条」，解析失败回退原前缀截断（300 字符位置实现时落档）。三类各有测试。
4. **[C20] 漏项提醒（不阻断）**：completion 请求缺 objective 某编号 criteria 的 `[Cn]` 行时，经 sendMessage followUp（triggerTurn:false）回注一次提醒列出缺失编号，audit 照常启动；objective 无编号 criteria 不提醒。测试：缺 C3 → 提醒含 C3 且 audit 仍启动；全覆盖 → 无提醒。
5. **[C21] 第 3 次提示**：auditAttempts 达 3（具名常量）UI 提示一次不阻断。测试钉住。
6. **[C22] recall 聚合**：离线脚本读 session jsonl 输出 Markdown 报告（delivery 分布、elapsedMs p50/p90、落地 turn 数分布、样本数，不足明说）+ waitMs 是否值得调整的建议及依据。默认值未改动。
7. **[C23] 三门禁全绿**。

**Out of scope**：audit 因缺证据阻断；只读 profile / OS 级沙箱；改 waitMs 默认值或 recall 逻辑；改 audit 判定与重试行为；reason 打印改动。

## 暂缓：评测集

live A/B 一次约 $150+，依赖 G2 快照冻结 memory fixture。先不做：C22 聚合已能零成本回答 recall 延迟问题；占位符/obs_recall 出现率也可离线统计。数据出来后用户拍板。

## 硬约束

① 每批开工先跑该批 Preflight，任何一条不成立停下汇报。② 不超 Success criteria 与边界；扩范围先汇报。③ 完成摘要逐条 `[Cn]` 格式，每条含 file:line + 测试名 + 输出摘要。④ 无法满足的条目写 `[DEVIATION Cn]` 附原因。⑤ 收尾全量测试 + 类型检查贴结果。⑥ 阈值（快照 10 份 / ≥3 文件 / ≥30% 字节 / 第 3 次提示）为具名常量。⑦ 默认假设：受保护路径 block 非 ask（摩擦大再改）；子会话只禁写不改 recall。⑧ G1→G2→G3 严格串行。

若受阻（preflight 失败、方案与代码冲突无法用已列替代表述解决、测试基线出现与批次无关的新红）：停下问用户。
