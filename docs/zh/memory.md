# memory — 项目记忆(单层)

> 中文版。English: [../en/memory.md](../en/memory.md)

**目录**:`extensions/memory/` —— 新模块(P3,V1 形状 + V2 扩容;自 2026-11-24
策略修订起单层)

## 做什么

单层(项目级)记忆系统:向 system prompt 注入带帽索引 + policy 块(仅在
session start / compaction 时重建)、在**任务开头的用户消息**上以持久化块
召回记忆文件(边界召回,仅 prompt 路径)、守卫记忆写入路径、按需手动整合、
并从 Claude / Hermes 格式导入。零运行时依赖,一条 LLM 通道。

跨项目用户层(`~/.pi/agent/memory/`)**已退役**:不再注入、不再召回、
不再写入、不再整合。其中遗留文件只读(pinned 文件在迁移到用户自己的笔记
完成前仍注入);guard 直接拒绝任何写入该目录的操作,导入器一律落到项目层。

## 关键表面

**接线 —— 2 工具 + 4 命令 + 钩子**(摘自 `index.ts` 文件头):

| 钩子 | 行为 |
|---|---|
| `session_start` | 项目层 reconcile + 设置加载 + 静态 yield 探测;记录 `sessionStartedAtMs`(召回回声过滤基线);注入缓存清空;**queue drain**(spec 2026-10-03)在设置就绪后后台触发(不占启动路径、按项目路由、永不 await);automation 自身的 `session_start` 重置全部每会话闭包态(A1);**AR1005-RC**:另防御性 dispose 召回机(reload/resume 驱动 —— 补充而非替代 `session_shutdown`)。已退役的用户目录刻意**不**创建/不 reindex |
| `before_agent_start` | 会话稳定注入(缓存)→ policy + 带帽索引;**任务边界召回,仅 prompt 路径** —— 真实用户消息只有当自最近 `compactionSummary` 起的 `userTurns < RECALL_BOUNDARY_TURNS`(2)时才触发选择;选择最多等待 `recallWaitMs`(默认 5000,钳制 1s–15s),超时即 **abort + 丢弃** —— prompt 路径放弃后绝无迟投递注入本 run。custom-message run(`sendMessage` `triggerTurn:true` —— goal 续跑、整合 directive)保留注入但永不选择 |
| `agent_end` | 后台 review 提取(完整 run 快照,≥10 turn / ≥15 tool call 门槛,≥3 用户消息 warmup,suffix-60 窗口上限,空窗口守卫 —— 不 run 中途提取,单 run 至多一次 LLM);model-wrote-memory 互斥抑制 LLM 但 cursor 照常推进 |
| `session_shutdown` | **AR1005-RC-04**:任意 shutdown 原因都 dispose 召回机 —— 同步执行、永不等待模型。晚到的选择器完成被 generation 失效丢弃:零 history 读取、零投递、零 unhandled rejection(契约 AR1005-RC-HOST 对真实 `ExtensionRunner` + `invalidate()` 钉住) |
| `tool_call` | `guardMemoryToolCall`(G1 判定;BH-R2:密钥探测只作用于记忆层路径 —— write 扫 `content`、edit 扫 `edits[].newText`);写入已退役用户目录的任何操作直接拒绝;已读抑制从历史推导(RV-07) |
| `tool_result` | 陈旧读 staleness 标注 |
| `agent_settled` | 清除整合 directive-turn 标记(automation 记账重开) |
| `registerTool` | `session_recall`(codemode)、`memory_lookup`(codemode)、`knowledge_search`(codemode)、`memory_consolidate` |
| `registerCommand` | `/memory`(含 recall 状态 + 退役层提示)、`/memory-consolidate`(仅手动,项目层)、`/memory-import-claude`、`/memory-import-hermes` |

**不再有 `message_end` / `turn_end` 召回或整合** —— 召回仅 prompt 路径
(run 中途的 steer 不是任务边界);整合绝不自动触发:超预算商店在 `/memory`
诊断中可见,`/memory-consolidate` 命令发送 directive。

**不再有 `context` 钩子** —— request 级投影是 30× 缓存未命中成本的根因
(RC-1/RC-2)。

**会话稳定注入**:policy 块只在 compaction 计数变化(或可写性翻转)时重建。
会话中途的 memory 写入绝不翻转 system prompt —— KV 缓存整个会话存活。

**任务边界召回细节**:
- 候选池:仅项目层,新→旧,**mtime ≥ `sessionStartedAtMs` 的文件被排除**
  (本会话写入的文件绝不回入池中 —— 无回声循环);
- 预算:每会话 ≤3 文件 / 16KB(`lib/context-budget.ts`);
- 选择器 query 携带上一条真实用户消息(≤1000 字符);
- 块以 `pi-memory-recall` custom message 持久化(`RecallDetailsV1` 冻结,
  契约 P0-CT-08;`delivery` 恒为 `"immediate"` —— 延迟投递时代已删除,
  `stats.late` 计被丢弃的超时)。

**配置**(`~/.pi/agent/settings.json`,`memory` 键):
- `model`(字符串,`"provider/id"`):ops 侧通道模型(review/correction/
  queue drain —— compact 与 shutdown 只 stage 队列记录,零 LLM)。回退链
  (spec 2026-10-03):`model` → `recallModel` → 会话模型 —— 无法解析的 ref
  继续尝试下一候选,绝不直接甩回慢的会话模型。与 D3 的不对称是刻意的:
  recall 把 `recallModel` 当**必备质量门**(未配 = 不召回),ops 把它当
  **廉价通道偏好**。
- `recallModel`(字符串,`"provider/id"`):选择器模型。**召回必须显式配置
  —— 未设置或无法解析 = 不召回**(D3,无词法回退)。
- `recallWaitMs`(数字,默认 **5000**,钳制 1s–15s):prompt 路径每消息的
  选择器等待预算。超时 = abort + 丢弃(绝无迟投递 —— prompt 路径返回后
  无任何注入)。

已知代价(接受):正 `recallWaitMs` 至多推迟主模型请求该预算,但只发生在
任务的头两条用户消息上;子 agent 会话同样加载 core —— child 的 dispatch
prompt 在同一边界预算内触发一次选择器调用。

**总线**:`memory` 通道 —— `{ yielded, dir }`;索引预算经
`contextBudget.memoryIndexMax` 发布(25K,`lib/context-budget.ts`)。

## 内部地图

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配;hook 体在边界 try/catch 包裹。只做事件路由 —— 一切召回决策都在 `recall.ts`。持有注入缓存、回声过滤基线、整合 directive-turn 标记 |
| `memdir.ts` | 目录扫描/reconcile;`scanMemoryDirCached` 指纹缓存 + 1s 新鲜窗口 TTL(全部内部写路径显式失效);`eligibleMemories(projectDir)` = 单层召回候选集(新→旧、绝对路径);`memoryKey` = 规范键 `memory/<file>`(重放 transcript 中的旧 `user-memory/` 键永远不再匹配) |
| `writer.ts` | 文档写入引擎(SPEC 2026-10-07 P2-3):write/remove/reindex —— 记忆文档与 MEMORY.md 的唯一变更路径;单向依赖 store/consolidate/importers → writer → memdir |
| `recall.ts` | **RV 深模块**(入口:`onUserMessage` / `abort` / `dispose`;AR1005-RC-01)。所有会话态每次调用都从投影历史推导(D9):边界判定 = 自最近 `compactionSummary` 起的真实用户消息数(RECALL_BOUNDARY_TURNS)、硬判重(RV-06)、已读抑制(RV-07)、字节预算(RV-08)、recentTools(RV-13)。skill 包裹剥离 + 长度卫生(RV-02);最新者胜的取代(RV-05);字节安全截断 + 路径注记渲染;`RecallDetailsV1`(冻结,契约已钉)。**AR1005-RC**:每个请求持有 generation + AbortController + 等待 timer —— 新消息、`abort`、`dispose` 或超时立即失效(晚到完成零 history 读取、零投递、零状态污染)。`onUserMessage` 为 total promise(RC-02) |
| `selector.ts` | `llmSelector`(共享 llm.ts 通道):清单行 = `[type] key (age): description` 新→旧、上限 200;精度优先提示词(空列表是合法答案);`previousUserMessage` 上下文行;`resolveRecallModel` = 精确 provider/id → 唯一裸 id → 关闭(绝不回退会话模型,D3) |
| `policy.ts` | 单层 policy 块(`policyCompact`)+ `buildPolicyInjection`(退役目录 pinned 段 + 项目索引,按 lane 钳制) |
| `guard.ts` | 写守卫:G1 判定 + 密钥探测 + 退役层阻断(写入用户目录一律拒绝并给迁移指引) |
| `yield.ts` | `InjectionGate` —— 静态 + 动态 yield 探测(fail-open:注入失败绝不阻塞 turn,P3-ME-09) |
| `consolidate.ts` | 仅手动整合:`sendConsolidationDirective`(命令)+ `memory_consolidate` 工具(批次必须减少字节或文件数)+ `needsConsolidation`(诊断) |
| `automation.ts` | P3 automation 状态 + 设置(经 `lib/settings` readJson 读取,不变量 10);`session_start` 每会话态重置(A1);`isDirectiveTurn` 接缝使整合 run 不进提取记账;queue drain 并行(`Promise.allSettled`,≤5) |
| `queue.ts` | 待提取队列(spec 2026-10-07 P0-3 单次 rename 所有权协议):shutdown 把未提取尾窗原子落盘为 `~/.pi/agent/memory-queue/` 下的一条 JSON 记录;下一个同项目 `session_start` 后台 drain。BH-E2:过期判定先于路由 skip;shutdown handler 本体**零 LLM** |
| `importers.ts` | Claude / Hermes 导入;一切落项目层(user 类型段转为 `reference`);绝不覆写本地编辑 |
| `store.ts`、`llm.ts`、`paths.ts` | V2 存储(原子写原语顺带失效扫描缓存)、唯一 LLM 通道、路径解析(`memoryWriteRoots` 仅项目目录 —— 已退役用户目录无审批 carve-out)。`MemoryLayer` 留在冻结的 MemoryOp 形状上;user 层 op 以显式理由跳过 |
| `lookup.ts` | 瘦身的按需半边:`memory_lookup(name)`(单条记忆全文;name 过写入侧同一套文件名白名单)与 `knowledge_search(query, scope)` —— 对记忆目录、`memory.searchRoots` 设置和/或过去会话(经 `session-recall.ts`)做大小写不敏感子串搜索;扫描 ≤2000 文件、返回 ≤20 条、只给命中行不给文件正文 |
| `stats-entry.ts` | `cc-core-memory-stats`:每个 agent run 一条 display-only entry,带瘦身计数器(索引字节/行数、超长描述数、记忆 read 次数、lookup/search 调用、recall 注入、改写描述数)—— 索引 A/B 的数据源 |
| `session-recall.ts` | 跨会话回溯(`session_recall` 工具):异步有界扫描 —— ≤200 文件、单文件 ≤1MB 有界部分读、总预算 ≤8MB、透明度尾部行 |

## 不变量与坑

- **Fail-open**:任何注入失败都在边界吞掉——turn 绝不能因 memory 打嗝而死。
- **单层**:项目目录是唯一被注入/召回/写入的商店。不要重新引入用户层、
  路由表或层选择提示 —— 跨项目知识属于用户自己的笔记,guard 现在直接
  阻断用户目录写入。
- **仅手动整合**:任何计时器或钩子都绝不发送整合 directive。触发器的
  throttle/2-per-session/inFlight 状态机已删除;`agent_settled` 只清
  directive-turn 标记。
- **边界召回**:仅当自最近 compaction 起真实用户消息数少于
  `RECALL_BOUNDARY_TURNS`(2)时选择;message_end/steer 路径永不选择;
  超时 = abort + 丢弃 —— 绝不恢复迟投递。
- **紧凑索引、按需取详情(context diet v3)**:索引行是 `- slug — description`(slug 即文件名主干,不再重复成链接)。描述是单行、至多 `DESCRIPTION_MAX`(80)字符的名词短语:`store.ts` 在 LLM 写入路径、`consolidate.ts` 在手动整合写入上拒收超长或多行项;`completeMemoryOpsCapped`(review、correction、queue drain)先做一次有界改写让同一批的其他事实不丢。导入与手写文件不过这两道门:索引给它们标 `⚠`,`/memory` 报数量,session_start 列一次。`memory_lookup`、`knowledge_search`、`session_recall` 是 `exposure: "codemode"` —— 不进工具清单;codemode 列出它们(`searchTools`)、脚本按名调用。(先试过 `"deferred"`,真机验收失败:pi 的 `tool_search` 默认注册为 inactive、除非 `defaultTools` 点名,deferred 工具别处不被列出。)`memory.searchRoots`(settings.json,绝对路径,默认 `[]`)是让 `knowledge_search` 扫笔记库的唯一入口;core 永不假设 vault 路径。`cc-core-memory-stats` entry 是探针:按会话对比瘦身前后的 read + lookup + search 次数。
- **会话稳定注入**:绝不在 memory 写入时重建 policy 块;重建键只有
  session start 与 compaction 计数。
- **零 LLM 退出(spec 2026-10-03)**:`session_shutdown` 只同步落盘一条队列
  记录;提取延后到 drain 通道。绝不在 `session_shutdown` handler 里重新
  引入 await 的 LLM 调用。
- **队列所有权协议(spec 2026-10-07 P0-3)**:同一条入队记录最多由一个存活
  worker 同时持有 —— 同目录单次原子 rename;claim 后重读;TTL + owner 探测
  回收。这是带重试的尽力队列,不是 exactly-once。新旧版本 core 并行 drain
  不安全 —— 升级时先停旧进程。
- **持久化一次投递(D1)**:召回块进入 transcript,每条真实用户消息至多
  一次;硬判重保证一个文件在一个 compaction 窗口内至多浮出一次(RV-06)。
- **无模型即无召回(D3)**:`memory.recallModel` 未设置/无法解析 → 召回
  整体关闭。绝不加词法或会话模型回退。
- **状态只来自历史(D9)**:wiring 无闭包态 —— 判重/已读/预算/边界全部从
  `buildSessionProjection().messages` 重推导。
- 导入器视本地文件为权威:导入永不覆盖本地编辑。
- 预算常量来自 `lib/context-budget.ts`(`RECALL_*` 刻意不进发布的
  `CONTEXT_BUDGET` 对象 —— 无消费方)。

## 测试

`test/lib/memory*.test.ts` + `recall.test.ts` + `memory-llm-selector.test.ts`
(vitest:core wiring、RV 状态机 + 边界 + 超时丢弃、RV 选择器、V2
storage/automation/consolidate/migration)与 `extensions/memory/tests/`
(node:test:B8 写根、BH-R2 探测范围、BH-E2 队列、C9 快照)。
`pi-memory-recall` customType + details-v1 字段集在契约套件钉住(P0-CT-08);
真实包 teardown 行为在 `pi-host-semantics.test.ts` ⑦ 钉住。
