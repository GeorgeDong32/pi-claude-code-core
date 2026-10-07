# SPEC P2-3：memory layer 写入引擎 + queue drain 编排归位

状态：writer / drain 已实施（7a006c0 / f989a32）；消息文本扁平化可选未做，后续不重复搬移。

> **实施记录（2026-10-07）**：已完成（commits 7a006c0 + 见 git log；详见 PROGRESS.md）。writer 三动词 + 单向依赖 + W4 双身份落地；drain 编排归位 queue-drain.ts（D-T1/D-T2 直测）。**可选项「消息文本扁平化」（§4.3）未实施**——按 spec 标注为可选，本批明确跳过（如需收敛另起独立 commit）。
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，报告 C3 / C4 卡片；清单项 CORE-14 / CORE-15

## 1. 背景

### 1.1 写入：invalidate 是调用方的义务

C7 引入的 1s TTL 扫描缓存（`memory/memdir.ts:158-172`）只有在每个写入点都记得 `invalidateMemDirCache` 时才正确：

| 写入点 | 原子 | invalidate |
|---|---|---|
| `store.ts:109-118` `atomicWriteFile` | ✓ | 内部 ✓ |
| `store.ts:288-289` `applyMemoryOps` 删除 | — | 手工 |
| `consolidate.ts:128-133` 删除循环 | — | 手工 |
| `importers.ts:51-52` 复制 | **✗** `writeFileSync` | 手工 |
| `importers.ts:191-193` frontmatter 写 | **✗** | 手工 |
| `memdir.ts:297-303` `reconcileMemoryIndex` 写 MEMORY.md | **✗** | — |

另外有两类重复知识：

- frontmatter 序列化有两份：`store.ts:71-74` 的 `renderFile` 与 `importers.ts:191` 的内联模板；解析只有 `memdir.ts` 的 `splitFrontmatter` 一份。
- 名称接近但**语义不同**的目录推导有三处，不能合并成同一个返回值：
  - `automation.ts:187-191` `projectKeyForDir`：取尾段；
  - `importers.ts:212-215` `projectKeyOf`：取父目录名；
  - `index.ts:175`：内联实现。

### 1.2 drain：协议写在 automation 里，且与 runOps 重复

`automation.ts` 有 768 行，包含四个概念：settings、correction 门、prompt 模板、queue drain（`605-742`）。其中 `runOps`（`377-414`）与 `drainOneRecord`（`653-699`）各写了一遍 "complete → apply → routedNotes / state 记账"。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
|---|---|---|---|---|---|
| W1 | 写入引擎的动词 | A 只补 `remove`；B **`write` / `remove` / `reindex` 三个动词** | **B** | — | 无 |
| W2 | 引擎的位置 | A 新文件 `memory/writer.ts`；B 扩展 `store.ts` | **A**（store.ts 保留 ops 语义，writer 只管磁盘） | B 少一个文件 | 无 |
| W3 | `invalidateMemDirCache` 的导出 | A 保留导出；B **仅 writer 与测试 helper 可用**（经 `@internal` 注释 + 源码扫描测试约束） | **B** | — | 测试 helper 需要改为调用 writer |
| W4 | projectKey 的权威 | A 维持三份；B **`paths.ts` 分别持有完整项目键与展示提示词** | **B** | — | 保留现有两套语义与调用方阈值；不把完整 key 截成提示词，否则会改坏 Hermes 匹配与路由 |
| W5 | drain 的位置 | A 留在 automation；B **`memory/queue-drain.ts`**，ports 为 `{ complete, applyOps, note }` | **B** | — | 无 |
| W6 | ops 流水线 | A 两份并存；B **`runOps` 与 drain 共用 `applyOpsOutcome`** | **B** | — | 计数字段名不变 |

## 3. 目标与非目标

**目标**
- memory 文档及 MEMORY.md 的写入 / 删除统一经 writer，成功后立即失效缓存；queue JSON、配置、锁文件分别保留在其 owner，不并入文档 writer。
- drain 可以脱离 hook harness 直接测试。

**非目标**
- 不改 memory 文件格式、目录布局（P0-CT-09）、`pi-memory-recall` custom message（P0-CT-08）。
- 不改召回（recall / recall-session）与注入预算。
- 不改 queue 记录格式与 claim 语义（P0-3）。

## 4. 设计

### 4.1 writer（`memory/writer.ts`）

- `write(dir, name, content)`：content 为 `{ kind: "raw", text }` 或 `{ kind: "memory", body, meta }`；raw 用于原样迁移、替换已有内容，不能重新序列化而丢掉未知 frontmatter。结构化新增使用统一 serializer。
- `remove(dir, name)`：成功 unlink 后失效缓存；ENOENT 幂等但仍清理可能的旧缓存，其余错误交由原调用方处理。
- `reindex(dir)`：沿用现有预算 / WARNING / malformed 文件策略，将索引原子写入；写失败保留旧 MEMORY.md 并返回 `rewrote:false`，不能缓存成写入成功。
- 同目录唯一临时名 + rename；写/rename 失败清理临时文件，保留原内容。basename / 路径越界 / symlink 安全检查不因搬移而省略；锁和 ops preflight 继续由 store/consolidate 持有，writer 不再次抢同一锁。
- **单向依赖**：`store/consolidate/importers → writer → memdir`。serializer 与 parser 在 memdir；reconcile 的写入编排搬入 writer，所有原 `reconcileMemoryIndex` 调用方同步改 import。memdir 不反向 import writer，不能产生 `memdir ↔ writer` 循环。
- writer 内写文档后 invalidate，再按现有调用时机 reindex；不得无条件每次 write 都重建索引，否则批量 ops 会反复重扫。reindex 自身更新索引缓存，不递归再次 reindex。
- “原子”仅指单文件可见性；多文件 ops/consolidation 的现有 preflight / 失败语义不升级成事务承诺。

项目身份收敛：`paths.ts` 分别提供完整 sanitized project key（Hermes 匹配继续使用）与 friendly hint（automation/诊断继续用末段，现有 ≥3 / ≥4 长度阈值留调用方）。`projectsDir` 的精确比较仍是 queue 路由权威。名字中带连字符、Windows 反斜杠、worktree 与短名都要 pin 原结果。

### 4.2 queue drain（`memory/queue-drain.ts`）

- `drainQueue(cap, ports) → Promise<DrainSummary>`：cap 是 session_start 时捕获的不可变 dirs/model/registry/projectKey；不保存或晚读 ctx。
- selection / claim / reread / attempts / complete / apply / settle-release 全归 drain，严格沿用 P0-3；`Promise.allSettled` 后返回一个汇总，automation 再提交诊断，不让并发 worker 改共享 state。
- complete 使用 20s 独立超时，不链接 sessionAbort；新 session 的 runtime 对象不能重定向旧 drain 的项目目录或诊断归属。旧 controller 可结束自己的诊断，但不能污染新 controller。
- `applyOpsOutcome` 收敛 completion 的应用结果与 routedNotes；runOps 与 drain 对同一 ops 的应用摘要一致，**触发器文案、诊断字段、空 ops 的计数与时间戳按现有各自策略保留**，不能为追求代码相同改变 flush/review 语义。
- automation 仍负责 settings、correction/review 调度、prompt、stageUnextractedTail 与 hooks；只搬 drain，不宣称它只剩 hook 接线。
- `ConversationPart` / queue record 所需共享类型移到 queue 自己的类型 owner，避免 queue → automation → queue-drain → queue 的反向依赖。

### 4.3 可选：消息文本扁平化

"把 message 的 content 摊平成文本"有 4 份局部实现：`index.ts:609-620`、`automation.ts:227-236`、`recall.ts:188-196`、`session-recall.ts:233-251`。可以收敛到 `memory/message-text.ts`，各处保留自己的角色过滤。**不强制**；若做，作为同批次的独立 commit。

## 5. 测试

| # | 用例 |
|---|---|
| W-T1 | `remove` 后 `scanMemoryDirCached` 立即看不到该文件（无需等 TTL） |
| W-T2 | 导入写在 rename 前崩溃（注入 `writeFileSync` 抛错）→ 目标位置不出现半截文件 |
| W-T3 | `reindex` 原子性（同上） |
| W-T4 | 有效结构化 meta 经 serialize→parse 后语义一致（title/name 映射、paths/pinned、换行与引号）；raw 迁移逐字节不变，不承诺任意历史 YAML 字节往返 |
| W-T5 | 完整 key / friendly hint 两套函数分别与原实现对拍；只用合成路径 fixture，不扫描真实用户 memory |
| W-T6 | 源码扫描：`invalidateMemDirCache(` 只出现在 writer、memdir 与测试 helper |
| D-T1 | `drainQueue` 直测：注入 `complete` 返回 ok / fail / throw，以及 apply-fatal 四种情况的 settle / release 序列 |
| D-T2 | 同一 ops 的应用摘要一致；触发器专属计数/文案保持原值，覆盖空 ops、失败、跨 session 结束 |

既有 `test/lib/memory-v2-*.test.ts` 断言不变；仅允许随 reconcile owner 变更更新 import。writer 与 memdir 无循环依赖；callback 抛错仍遵守 memory fail-open。

## 6. 门禁、回滚、台账

- writer、路径命名收敛、drain 分提交，每批三绿。
- 回滚：drain 接在 P0-3 之上，可单独回滚；writer 的调用方与 import 必须同批还原，不拆半边。
- `docs/{en,zh}/memory.md` 模块表更新；`PROGRESS.md` 记录；原子导入/索引更新是可见可靠性变化，补 CHANGELOG；任何新行为差异先登记 DEVIATIONS，不把 key 语义变更混入重构。
