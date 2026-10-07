# SPEC P0-3：memory 待提取队列逐条 claim

状态：规格已补齐，待实施；独立审查后采用单次 rename 转移协议
日期：2026-10-07
来源：联合架构审查 CORE-04；P2-3 在本协议落地后搬移 drain 编排
基线：core `09c2dcb`，`extensions/memory/queue.ts` 与 `automation.ts#drainOneRecord / drainPendingRecords`

## 1. 缺陷与保证范围

现有 drain 在 `loadQueue` 后直接 `bumpAttempts → completeMemoryOps → applyMemoryOps → removeRecord`。LLM 等待期间另一个 automation 实例或 pi 进程可以读取同一记录，重复计次、调用模型并应用结果。进程内的同步 apply 无法保护跨进程的整个消费周期。

本 spec 保证：**所有参与者升级到本协议后，同一条已入队记录最多由一个存活 worker 同时处理**。一次占有只计一次尝试，失败可释放，死进程遗留可回收。消费、释放、回收与 GC 都遵守同一所有权协议。

这是带重试的尽力处理队列，不是 exactly-once 存储事务：apply 已写入记忆、settle 尚未删队列文件时崩溃，下一次可能再次 apply。解决该窗口需要持久化幂等凭证，与记忆写入一起提交，另立 spec。相同 session 后来暂存的重叠文本也不由本 claim 协议去重。

## 2. 决策登记

| # | 问题 | 选择 | 放弃 / 风险 |
|---|---|---|---|
| Q1 | 互斥粒度 | 逐条同目录 rename-to-claim；每次转移只做一次 rename | 进程内标志不覆盖跨进程；全目录锁会把不同项目的 20s 提取串行化 |
| Q2 | 过期回收 | 至少 10 分钟且 owner **已确认不存在**才回收；TTL 不是剥夺活 worker 所有权的租约 | 活进程挂起不自动夺锁；PID 重用或无权探测时可能延后回收，优先保住互斥 |
| Q3 | 混合版本 | 不保证与旧 core 并行安全；升级 / 回滚应先退出旧进程 | 旧进程可能已把 JSON 读进内存，之后的 bumpAttempts 会重新创建原文件；仅“不以 .json 结尾”不足以阻止它 |
| Q4 | 释放与重试 | claim rename 到唯一 pending 名，永不恢复可重用的 ready 原名；pending 与 ready 一样可被 claim | 增加一种临时后缀；不采用会产生双名窗口的 hard-link 释放 |
| Q5 | GC | 计入 claim 占用，但不能删除活跃或存活状态未知的 claim；其他候选也必须先取得 token | 2MiB 仍是尽力软预算；并发暂存 / 活跃 claim 可能暂时超额，不把软预算描述为严格硬上限 |

`FLUSH_QUEUE_MS=20_000` 大于平均耗时或小于 TTL 都不能证明 worker 已停止；回收必须做 Q2 的所有权检查。

## 3. 冻结面与文件形状

原始 JSON v1 与首次暂存路径保持不变：

```
~/.pi/agent/memory-queue/<sessionId[:8]>-<savedAt>.json
  { v, sessionId, projectsDir, projectKey, cwd, savedAt, attempts, parts }
```

以 `<original>` 表示上述 ready basename：

- 占有态：`<original>.claim.<pid>.<claimedAtMs>.<nonce>`。
- 可重试态：`<original>.pending.<nonce>`。
- claim / pending 均不以 `.json` 结尾；nonce 每次转移重新生成随机 UUID，不复用任何旧路径，也不把前一次后缀嵌套进去。
- 垃圾占有态：`.gc.<pid>.<claimedAtMs>.<nonce>.tmp`，只承载已独占取得的遗留写入 tmp，不是队列记录，不参与 ready/pending/claim 消费。其 owner 与时间可从名称读取。
- token 携带当前完整 basename、owner 与原始 basename；不接受来自记录内容的任意路径。文件名前缀不是 session 身份，完整 `sessionId` 才是。

适用本机文件系统的同目录原子 rename；网络共享目录不在保证范围。唯一目标名是协议前提；遇到已存在的目标名重新生成 token，不以覆盖目标实现互斥。JSON 写入使用 `lib/settings.ts#writeJsonAtomic`；读取走 `readJson` 后做既有 QueueRecord 校验，不改字段和失败回落。其写入 tmp 不是可消费记录，不参与 claim 枚举。

**先登记再写测试**：P0-CT-09 的 memory-queue 行追加 claim / pending / GC token 后缀、owner 回收和软预算说明。旧 ready 名称 / v1 内容仍冻结。

## 4. queue interface 与所有权

| 操作 | 语义 |
|---|---|
| `claimRecord(agentDir, candidate)` | 原 ready 或 pending 路径一次 rename 到全新 claim 名；ENOENT 返回 null。成功后**从 claim 文件重新读取**记录，绝不继续使用 loadQueue 的缓存内容 |
| `bumpClaimedAttempts(claim)` | 仅 owner 可调用；在 LLM 前原子写 attempts+1，成功后更新本次内存值。失败不调用模型 |
| `settleClaim(claim)` | 仅删除这个 token 的 claim；不按原 basename 删除任何 ready / pending；重复调用幂等 |
| `releaseClaim(claim)` | 一次 rename 到全新 pending 名；不 link、不恢复原 ready。成功即失去所有权，旧 token 的任何后续操作不得重建源文件 |
| `reclaimStaleClaims(agentDir, now, ownerProbe)` | TTL 已到且 ownerProbe 为 dead（本机 `kill(pid, 0)` 的 ESRCH）才将旧 claim **直接 rename 为回收者的新 claim**。alive / EPERM / unknown 一律跳过；竞争失败返回空，成功返回独占 token，后续重读、处理或 release |
| `queueInventory(agentDir)` | 统计 ready、pending 与 claim；时间取原 basename 的 savedAt，不取 claim 时间。枚举可能因并发转移短暂陈旧，只用于展示与软预算，不能授权删除。GC token 与写入 tmp 计入占用字节，不计入记录数或 oldestSavedAt |

所有权只经 claim 成功取得。路由 `projectsDir`、年龄、parts、attempts 上限必须在 claim 后重查；目录枚举仅提供候选，不授权删除或处理。无效 / 已超限记录由持有者 settle；不匹配本项目则 release。这样迟到的枚举结果不会消费另一个项目新写入的同名文件，也不会把旧 attempts 覆盖回去。session blacklist 按原 basename + 完整 sessionId 标识同一记录，不能因 release 换了 pending 名就绕过。

release/settle 之前 worker 必须已结束 apply；活进程的 claim 不允许被 TTL 回收。每个 token 只能终结一次；失败重试也不能在失去所有权后继续 bump 或 apply。

### 4.1 为什么不能 link 后 unlink

独立审查用真实文件操作复现了上一稿的竞态：R1 `link(deadClaim, ready)` 后暂停 → A 把 ready rename 为 A.claim → R2 再 `link(deadClaim, ready)` 成功 → B 取得 B.claim。两个存活 worker 同时持有同一条记录；这不是 §1 已披露的崩溃重试窗口。

新协议每一步都原子消费唯一源路径：ready/pending → claim、死 claim → 新 claim、claim → 新 pending。两个竞争者只有一个能消费同一源；源 claim/pending 名永不重用。任一转移前后崩溃都只留下一个队列记录路径（原子写入的 tmp 除外），没有供第二个回收者再次释放的别名。上线协议禁止 hard-link；不能用 inode 去重补救所有权错误。

### 4.2 暂存与 GC

审查初稿称 `enforceBudget` 会忽略 claim，**不符合源码**：它实际遍历全部目录项。实施必须一起改：

- `loadQueue` 改为候选枚举，不直接删除坏文件或过期文件；删除也要先 claim、重读并核实条件。
- `writeQueueRecord` 的同 session 替换只针对 ready / pending：先取得唯一 claim，再按完整 sessionId 与 savedAt 重查，仅移除本次记录可替换的较早记录；不删除并发新暂存，不改活 worker 的 claim。不匹配则 release。
- `enforceBudget` 将 ready、pending、claim 与 tmp 计入占用；淘汰 ready / pending 前必须先 claim，再复核、settle。死 claim 也只能通过 Q2 回收取得 token 后删除；不能依据陈旧的枚举路径 unlink。
- 写入中的 tmp 不删除；只回收格式可识别、已超过阈值且 owner 确认为 dead 的 tmp，先 rename 到 §3 的全新 GC token 后删除。GC token 的活 / 未知 owner 同样受保护；超过 10 分钟且 owner 确认为 dead 后，回收者先将其单次 rename 为自己的全新 GC token 再删除，避免 GC 在 rename 后崩溃造成永久泄漏。未知目录项保留并诊断，不猜测所有者。
- 新暂存触发预算清理仍不能腾出空间时，尝试 claim 这次 ready，重读确认仍是本次记录后丢弃并报告既有诊断；若已被 worker 取走则保护其 claim。不能牺牲别人的在途记录以满足软预算。
- 7 天过期检查对 claim 在安全回收后执行；不能仅凭年龄删除活 worker 的记录。

### 4.3 drain 编排

```
枚举 ready/pending 或死 claim → 独占 claim → 重读 / 路由 / 上限校验 → bump → complete → apply → settle/release
```

| 结果 | 处置 |
|---|---|
| claim 失败（被占有） | 跳过，不计尝试、不调 LLM、不改诊断成功计数 |
| bump 失败 | release；本 session blacklist；返回诊断 |
| complete ok，含零 ops | apply 成功（或无需 apply）后 settle |
| apply 返回既有 deterministic fatal | 沿用当前消费并丢弃语义，settle + lastError |
| complete 失败 / 抛错 | attempts 未用完则 release；耗尽则 settle + lastError |
| apply 意外抛错 | 不自动当成成功；记录 lastError 并在 finally 释放。可能已部分写入的重试风险遵守 §1 |
| 任何路径的 release/settle 自身失败 | 不让后台 promise 泄漏；保留可诊断的 claim，后续按安全回收协议处理 |

保持 `Promise.allSettled` 聚合诊断、`QUEUE_DRAIN_MAX`、精确项目路由、不链接 sessionAbort 的行为。cap 在取得合法记录后计数。每个 worker 在 finally 结清仍持有的 token；没有只在 happy path 清理的出口。

## 5. 验收测试（vitest）

`test/lib/memory-queue-claim.test.ts` + `memory-v2-automation.test.ts`，deferred 控制模型返回，不靠 sleep 制造竞争。

| # | 场景与断言 |
|---|---|
| Q-T1 | 两个 automation 实例 /new 重叠 drain，同一文件只调一次 complete；持有期间磁盘 attempts=1 |
| Q-T2 | 两个独立 Node 子进程在 barrier 后竞争 rename；恰有一个 owner，另一方零 LLM / apply |
| Q-T3 | A 枚举后 B claim→bump→失败 release；旧候选返回 ENOENT；重新枚举 pending 再 claim 必须读到最新 attempts，不能回退计数 |
| Q-T4 | complete fail / throw、apply fatal / throw、bump 写盘失败，各分支按 §4.3 settle/release；零悬空 rejected promise；换名后 blacklist 仍有效 |
| Q-T5 | 超 TTL 的活 owner 不回收；死 owner 回收；未知 / PID 重用保留；两个回收者竞争同一死 claim 仅一个成功 |
| Q-T6 | 在 claim/release/reclaim 每次 rename 前后分别终止进程；恰留一条可恢复记录，JSON 与 attempts 保持；旧 token 不得重建路径 |
| Q-T7 | GC 压力不删除活 / 未知 owner 的 claim / tmp / GC token；inventory 包含 pending，GC token 只计字节，年龄按原记录；遗留 tmp→GC token 后崩溃，过 TTL 双回收者仅一个取得并删除；软预算不假称严格上限 |
| Q-T8 | claim 后重查路由 / 上限；GC 或同 session 替换先枚举、另一 worker 取得 token 后，迟到删除不得碰在途文件；新 ready 需重新核验身份和时间 |
| Q-T9 | apply 完成、settle 前模拟崩溃：验证可重试但不声称 exactly-once；重复写入风险有文档 |
| Q-T10 | 固定 §4.1 的双回收者交错：R1 成功 rename 后暂停，worker A/B 与 R2 均不能再取得旧 claim；R1 release 到 pending 后也只有一个后续 owner |
| Q-T11 | 原 ready 名被新暂存复用时，旧 token settle/release 不改新 ready；所有 claim/pending nonce 不复用；未知后缀不被当作队列记录消费或清理 |

Q-T1 为基线红测试；Q-T2 是跨进程互斥证据，不能仅用同一事件循环的两个调用替代。P0-CT-09 测试只钉冻结形状与新临时后缀，协议细节放 lib 测试。

## 6. 实施、回滚与台账

1. 契约表附注 → 基线红测试取证 → queue 所有权 / GC → drain 接线 → 文档。
2. `bun run check`、`bun run test`、`bun run contracts` 三绿。
3. 回滚前停止所有队列写入与 drain 进程；在此离线状态下逐条检查原 ready 不存在才 rename 还原 claim / pending。冲突保留并报告，不覆盖现存文件；旧代码不认识新后缀，不能直接 revert 后宣称数据可消费。
4. docs/en/memory.md 与 docs/zh/memory.md 同步互斥范围、恢复、混合版本限制与软预算；CHANGELOG / PROGRESS / queue 头注释更新。
5. DEVIATIONS 记录临时文件布局补充与预算披露；不把 §1 的非 exactly-once 局限记成已解决。
