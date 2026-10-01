# memory — 双层记忆

> 中文版。English: [../en/memory.md](../en/memory.md)

**目录**:`extensions/memory/` —— 新模块(P3,V1 形状 + V2 扩容)

## 做什么

双层(用户级 + 项目级)记忆系统:扫描记忆目录、向上下文注入带预算上限的
lexical 索引、守卫记忆写入路径、自动整合(consolidation)、并从 Claude /
Hermes 格式导入。零运行时依赖,一条 LLM 通道。

## 关键表面

**接线 —— 2 工具 + 4 命令 + 9 钩子**(摘自 `index.ts` 文件头):

| 钩子 | 行为 |
|---|---|
| `session_start` | 双层 reconcile + 预算重置 + 静态 yield 探测 |
| `session_compact` | 每 turn 预算重置 |
| `before_agent_start` | 动态 yield 探测 → policy + 双层带帽索引 |
| `context` | lexical `selectForTurn` 注入(双层合并池) |
| `tool_call` | `guardMemoryWrites` 秘密拦截器(双层) |
| `turn_end` | 自动整合触发(V2-C)+ P3 automation |
| `tool_result` | `memory_consolidate` settle |
| `agent_settled` | 清除整合进行中标记 |
| `registerTool` | `session_recall`、`memory_consolidate` |
| `registerCommand` | `/memory`、`/memory-consolidate`、`/memory-import-claude`、`/memory-import-hermes` |

**总线**:`memory` 通道 —— `{ yielded, dir }`;索引预算经
`contextBudget.memoryIndexMax` 发布(25K,`lib/context-budget.ts`)。

## 内部地图

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配;注入类 hook 体在边界 try/catch 包裹。context hook = **per-turn pin & re-project**(MR-01,spec 2026-10-01):turn 首个请求选取一次,后续请求重投影字节级同一块;`surfacedKeys` = 纯计费判重;只尾部追加 + systemPrompt 字节稳定(MR-09 缓存纪律) |
| `memdir.ts` | 目录扫描/reconcile;`scanMemoryDirCached` 指纹缓存 + git root memo(缓存命中的 turn 零内容读) |
| `selection.ts` | `selectForTurn` 双域资格(MR-04):primary = title+description ≥2 命中,或次级 = ≥1 primary + ≥2 body 命中;body-only 永不入选,body 命中仅同分 tiebreaker;`isPrePaid` 谓词使已计费文件不再消耗预算(MR-05)。CJK bigram 分词;全量按字节计(`byteLength`) |
| `policy.ts` | policy 注入块(`POLICY_COMPACT`) |
| `guard.ts` | 记忆写路径的秘密拦截器(secret regex,含无引号值 / base64 padding) |
| `yield.ts` | `InjectionGate` —— 静态 + 动态 yield 探测(fail-open:注入失败绝不阻塞 turn,P3-ME-09) |
| `consolidate.ts` | 整合触发/工具/命令;写入走 `memory_consolidate`(批次必须减少字节或文件数) |
| `automation.ts` | P3 automation 状态 + 设置 |
| `importers.ts` | Claude / Hermes 导入;绝不覆写本地编辑 |
| `store.ts`、`llm.ts`、`session-recall.ts`、`paths.ts` | V2 存储、唯一 LLM 通道、跨会话回溯(`session_recall` 工具)、路径解析 |

## 不变量与坑

- **Fail-open**:任何注入失败都在边界吞掉——turn 绝不能因 memory 打嗝而死。
- CJK 文本必须走 bigram 路径——不要把分词「简化」回空白切分。
- 导入器视本地文件为权威:导入永不覆盖本地编辑。
- 预算常量来自 `lib/context-budget.ts`。

## 测试

`test/lib/memory*.test.ts`(vitest:core、V2 storage/automation/consolidate/
migration、carveout)—— memory 的套件保留在 `test/lib`,未就近摆放。
