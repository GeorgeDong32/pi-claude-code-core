# memory — 双层记忆

> 中文版。English: [../en/memory.md](../en/memory.md)

**目录**:`extensions/memory/` —— 新模块(P3,V1 形状 + V2 扩容)

## 做什么

双层(用户级 + 项目级)记忆系统:向 system prompt 注入带帽索引、以
**每条用户消息至多一次的持久化块**召回记忆文件(LLM 清单选择器,RV,
spec 2026-10-02-memory-recall-v2)、守卫记忆写入路径、自动整合
(consolidation)、并从 Claude / Hermes 格式导入。零运行时依赖,一条 LLM 通道。

## 关键表面

**接线 —— 2 工具 + 4 命令 + 8 钩子**(摘自 `index.ts` 文件头):

| 钩子 | 行为 |
|---|---|
| `session_start` | 双层 reconcile + 设置加载 + 静态 yield 探测；**queue drain**（spec 2026-10-03）在设置就绪后后台触发（不占启动路径、按项目路由、永不 await）；automation 自身的 `session_start` 重置全部每会话闭包态（A1 —— 宿主在进程内 `/new`、`/resume`、`/fork` 后复用同一批 handler 闭包，不重置则已死的 AbortController 会在首次切换后静默杀死全部 automation） |
| `before_agent_start` | 动态 yield 探测 → policy + 双层带帽索引;**RV prompt 路径** —— 每条用户消息一次选择(受 `recallWaitMs` 限时),块作为 custom message 持久化在用户消息之后 |
| `message_end` | **RV steer 路径** —— run 中途到达的用户消息以等待 0 选择;custom 块永不触发(RV-01)。spec v1.2:挂起的选择**一完成即投递**(`sendMessage` `triggerTurn:false` 入 pi 的 pending 队列,下一个 turn_end 落盘 —— 最早 = 首条模型消息结束):run 内 request #2 起可见,run 结束则下一轮 request #1 可见。永不丢弃;`display:false` 保证两个 TUI 都不渲染 |
| `turn_end` | P3 automation 计数 + correction 门(≤1/3 turn;review 提取已挪 `agent_end`,2026-10-03;spec v1.2:召回投递不再按 turn 门控 —— 见 `message_end`) |
| `agent_end` | spec v1.2:仅清 prompt 标记 —— 在途选择仍可完成后投递(下一轮可见);最新者胜的取代发生在下一条用户消息 + 后台 review 提取(2026-10-03 自 turn_end 挪入:完整 run 快照,≥10 turn / ≥15 tool call 门槛,suffix-60 窗口上限,空窗口守卫 —— 不再 run 中途提取,单 run 至多一次 LLM) |
| `tool_call` | `guardMemoryWrites` 秘密拦截器(双层);已读抑制改为从历史推导(RV-07) |
| `tool_result` | `memory_consolidate` settle + 陈旧读 staleness 标注 |
| `agent_settled` | 清除整合进行中标记 |
| `registerTool` | `session_recall`、`memory_consolidate` |
| `registerCommand` | `/memory`(含 recall 状态)、`/memory-consolidate`、`/memory-import-claude`、`/memory-import-hermes` |

**不再有 `context` 钩子** —— request 级投影是 30× 缓存未命中成本与
「冻结选集反复重投」两大病灶的根因(RC-1/RC-2)。

**配置**(`~/.pi/agent/settings.json`,`memory` 键):
- `model`(字符串,`"provider/id"`):ops 侧通道模型(review/correction/queue drain —— compact 与 shutdown 只 stage 队列记录，零 LLM)。回退链(spec 2026-10-03):`model` → `recallModel` → 会话模型 —— 无法解析的 ref 会继续尝试下一候选，绝不直接甩回慢的会话模型。与 D3 的不对称是刻意的：recall 把 `recallModel` 当**必备质量门**（未配 = 不召回），ops 把它当**廉价通道偏好**（解析不到 → 会话模型，不算失败）；因此 ops 的输出质量随所配 `recallModel` 的模型而定（已披露）。
- `recallModel`(字符串,`"provider/id"`):选择器模型。**召回必须显式配置
  —— 未设置或无法解析 = 不召回**(D3,无词法回退)。
- `recallWaitMs`(数字,spec v1.2 起**默认 0**,钳制 0–15000):prompt 路径每消息的选择器等待预算。0 = 永不因选择器阻塞上屏 —— 块经完成驱动的 pending 落盘到达;正值 = 用上屏延迟换 request-#1 召回。

已知代价(spec D4 + handoff 陷阱,接受):`before_agent_start` 的 handler
链是串行 await 的,等待(仅配置了选择器模型时)会推迟后续扩展的 handler
与主模型请求,最多 `recallWaitMs`;子 agent 会话同样加载 core —— 每个
child 的 dispatch prompt 触发一次选择器调用(token 费 + ≤waitMs 首 token
延迟)。这是预期行为,不是需要特判的 bug。

**总线**:`memory` 通道 —— `{ yielded, dir }`;索引预算经
`contextBudget.memoryIndexMax` 发布(25K,`lib/context-budget.ts`)。

## 内部地图

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配;hook 体在边界 try/catch 包裹。只做事件路由 —— 一切召回决策都在 `recall.ts` |
| `memdir.ts` | 目录扫描/reconcile;`scanMemoryDirCached` 指纹缓存 + git root memo + 1s 新鲜窗口 TTL(arch review C7:同轮后续扫描免 readdir+stat 指纹趟;外部编辑最长 ~1s 可见 —— 全部内部写路径显式失效);`eligibleMemories` = 召回候选集(双层、新→旧、绝对路径);`memoryKey` = 规范键 `user-memory/<file>` / `memory/<file>` |
| `recall.ts` | **RV 深模块**(三入口:`onUserMessage` / `onTurnEnd` / `abort`)。所有会话态每次调用都从投影历史推导(D9):自最近 `compactionSummary` 起的硬判重(RV-06)、read toolCall 按 cwd 解析的已读抑制(RV-07)、按历史 `details.bytes` 累计的字节预算(RV-08)、自最近用户消息起成功且从未失败的 recentTools(RV-13)。skill 包裹剥离 + 长度卫生(RV-02);最新者胜的取代(RV-05);字节安全截断 + 路径注记渲染;`RecallDetailsV1`(冻结,契约已钉) |
| `selector.ts` | `llmSelector`(共享 llm.ts 通道):清单行 = `[layer][type] key (age): description` 新→旧、上限 200;精度优先提示词(空列表是合法答案);recentTools 反噪音规则;`resolveRecallModel` = 精确 provider/id → 唯一裸 id → 关闭(绝不回退会话模型,D3) |
| `policy.ts` | policy 注入块(`POLICY_COMPACT`) |
| `guard.ts` | 记忆写路径的秘密拦截器(secret regex,含无引号值 / base64 padding) |
| `yield.ts` | `InjectionGate` —— 静态 + 动态 yield 探测(fail-open:注入失败绝不阻塞 turn,P3-ME-09) |
| `consolidate.ts` | 整合触发/工具/命令;写入走 `memory_consolidate`(批次必须减少字节或文件数) |
| `automation.ts` | P3 automation 状态 + 设置(经 `lib/settings` readJson 读取,不变量 10);`session_start` 每会话态重置(A1);queue drain 并行(`Promise.allSettled`,≤5 —— 最坏 5×20s 串行 → max(20s);诊断单点聚合写入) |
| `queue.ts` | 待提取队列(spec 2026-10-03):shutdown 路径把未提取尾窗（cursor 相对的后缀 60 条）原子落盘为 `~/.pi/agent/memory-queue/` 下的一条 JSON 记录；下一个同项目 `session_start` 后台 drain（≤5 条、≤3 次尝试、`projectsDir` 精确路由、年龄/体积 GC）。shutdown handler 本体**零 LLM** —— 宿主串行 await 全部 shutdown handler 且无超时兑底，旧的 await 10s flush 实测让每次长会话退出必卡满 10s。记录是会话尾窗的明文第二副本（≤7 天、总量 ≤2MB），在此披露 |
| `importers.ts` | Claude / Hermes 导入;绝不覆写本地编辑 |
| `store.ts`、`llm.ts`、`paths.ts` | V2 存储(原子写原语顺带失效扫描缓存)、唯一 LLM 通道、路径解析(`sessionsDirFor` 用 pi 的包裹横杠 sessions 命名 `-${sanitize}-`) |
| `session-recall.ts` | 跨会话回溯(`session_recall` 工具)。arch review C8:异步有界扫描(不卡事件循环)+ 三重上限 —— ≤200 文件(新→旧)、单文件 ≤1MB 有界部分读(从不整文件跳过:最新会话往往最大)、总预算 ≤8MB —— 加透明度尾部行(`scanned=… truncated_size=… budget=… bytes=…/…`;「收窄 query」提示只在预算耗尽时)。sessions 目录路径修复使该工具首次在真机可用(此前指向 pi 从不写入的目录) |

## 不变量与坑

- **Fail-open**:任何注入失败都在边界吞掉——turn 绝不能因 memory 打嗝而死。
- **零 LLM 退出（spec 2026-10-03）**:`session_shutdown` 只同步落盘一条队列
  记录（原子写，≤120KB）；提取延后到 drain 通道。绝不在 `session_shutdown`
  handler 里重新引入 await 的 LLM 调用。
- **持久化一次投递(D1)**:召回块以 `pi-memory-recall` custom message
  进入 transcript,每条真实用户消息至多一次 —— custom 块自身永不触发召回
  (RV-01);历史推导的硬判重保证一个文件在一个 compaction 窗口内至多浮出
  一次(RV-06)。
- **无模型即无召回(D3)**:`memory.recallModel` 未设置/无法解析 → 召回
  整体关闭。绝不加词法或会话模型回退。
- **状态只来自历史(D9)**:wiring 无闭包态 —— 判重/已读/预算/recentTools
  全部从 `buildSessionProjection().messages` 重推导(details 存活性已被
  契约钉住)。
- 导入器视本地文件为权威:导入永不覆盖本地编辑。
- 预算常量来自 `lib/context-budget.ts`(`RECALL_*` 刻意不进发布的
  `CONTEXT_BUDGET` 对象 —— 无消费方)。

## 测试

`test/lib/memory*.test.ts` + `recall.test.ts` + `memory-llm-selector.test.ts`
(vitest:core wiring、RV 状态机、RV 选择器、V2 storage/automation/
consolidate/migration、carveout)—— memory 的套件保留在 `test/lib`,未就
近摆放。`pi-memory-recall` customType + details-v1 字段集在契约套件钉住
(P0-CT-08);真实包 `buildSessionProjection` 的 details 存活性在
`pi-host-semantics.test.ts` ⑥ 钉住。
