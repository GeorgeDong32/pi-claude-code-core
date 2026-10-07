# 2026-10-07 规格续写与核对记录

状态：规格编写完成；实现未开始；D3 / D4 / D6 待用户决策；独立复审修订见末节。

## 来源与范围

用户提供的 `8939bee8-903c-4704-a99c-6a14d7b351e6` 在 Devin 本地记录中对应 request_id，归属会话 `gray-termite`（“代码库架构与逻辑优化审查”）。该请求最后写出了两个 spec/README.md，todo 仍停在“两仓 spec 索引 + 自检（行号/路径/交叉引用）”。

已核对主会话最后的用户要求：D1 照常询问；D2 已授权 MCP 可用、其他 edit 不可用；D3 要求展开解释；D4 允许考虑删 reader；D5 footer 以 TUI 为准；其余按优先级拆 spec 放两个仓库。本次用户明确“先把 spec 写好”，因此只修改 spec 文档。

基线：core `09c2dcb`，TUI `7192d9f`。原临时报告目录为 `pi-cc-review-20261007-1803`；其两份清单用于覆盖核对，实施不依赖临时目录存活。bus 复现条件已写入 TUI P0-2 的验收，不能把旧 sims 的存在当成新代码测试已通过。

## 首轮源码核对与补充（下表已同步独立审查修订）

| 项 | 源码证据 / 原稿问题 | 已写入规格的处置 |
|---|---|---|
| plan / fusion | fusion-tools 只认字符串；action-fusion 实际注册 then_run 对象 | P0-1 增 FUS-SHAPE；合法 plan 路径配危险 command 的红测试，不能让路径拦截遮住漏检 |
| permission 深化 | 纯函数草案传入可能读盘的 family/path 回调，且暴露过多组装知识 | P2-1 用一个 check seam 包住采集/纯 decide/interpreter；显式列短路顺序与副作用 trace |
| embedded 询问 | 实际 handler 询问后直接返回整个调用结果 | 保持该终态，不能因重构在批准后再次询问外层工具 |
| goal 生命周期 | removeFocusedGoal 仅定义无调用；原稿据其缺失 cleanup 声称修 bug | 改为死代码清理；只对可达转移对拍，不新增无根据的“完整副作用” |
| queue 所有权 | 旧 worker 已读入 JSON 时，rename 后仍能 bump 重建 ready | 撤销混合版本安全保证；claim 后重新读取与验证，不消费旧缓存 |
| queue GC / 回收 | enforceBudget 扫全部文件；TTL 不能证明 owner 已停止 | 活 owner 不夺锁；claim 计入预算但不被 GC 删除；单次 rename 到唯一 pending；所有删除先取 token；跨进程验收 |
| queue 崩溃 | apply 与删除队列不在同一事务 | 明确不是 exactly-once，不掩盖 apply 后崩溃可能重试的窗口 |
| memory 写入 | writer 调回 memdir 容易形成循环；full project key 与 friendly hint 不等价 | 单向依赖、raw 导入保真、原子索引、两种 key 分名保语义 |
| bus 导出/footer | reader 无 TUI 调用；footer 多来源覆盖、加载期发布 | reader 去留待 D4；实例隔离 footer、事件内发布与配对测试；off 恢复 stock 的例外明确 |
| TUI 生命周期 | header 捕获 ctx；widget 重注册 timer 可跨 session 迟到 | generation + 显式取消、逐资源容错、非 TUI 后续事件守卫、宽度安全降级 |
| bus 通知 / obs | attach 时 fast-forward 会跳过交接窗口；onChange 不回放；sites 只有最后批次 | activate 捕获基线、attach 立即消费、旧回调失效、native footer 重试、各自去重与局限 |
| 工具展示 | proxy resolver 拿不到 args；强认领裸 mcp 会抢 renderer | 仅有足够证据时接管；renderCall 再读 args；details 校验、正文保留、schema 回退范围 |
| 用量 | 丢弃左侧数字时替代槽可能为空；optional ctx 不等于 0 | 显示归属矩阵、脚本错误兜底、逐字段回退、同源 JSON、跨 session 清空 |
| 小项 | readJson 第三参写错；git status 跨 await 复用会陈旧 | 改为真实回调参数；在最终工作区只采样一次并生成对应 label/hint |
| widget 排序 | setTimeout(0) 不保证排在任意异步 handler 之后 | XPKG-09-HOST 记录假设与未取证状态，不禁止 core 合法重注册 |

这些是**规格修订**，尚未成为生产行为。实施时的代码偏离才写 DEVIATIONS，不能将本记录替代该 ledger。

## 覆盖与决策

- core 清单 CORE-01…19：全部映射到 [9 份规格](README.md)。CORE-17 本批仅 startPlanExecution，完整 PlanSession 暂缓。
- TUI 清单 TUI-01…15：全部映射到 [6 份规格](../../pi-claude-code-tui/spec/README.md)。effort pin 与 ANSI 合并保持可选。
- D3 未选：P0-2 提供 A/B/C/D，推荐 A；锁策略与 G3 必须一起落地，仅 CORE-05 drafting 复位可独立。
- D4 未选：P1-1 保留 A（保留并修正类型）/ B（删除）的具体方案；未选定前不删除 reader、export 或行为断言。TUI 不依赖此删除。
- D6 未选：core P3-1 S3 提供转发或提示规则，推荐 B；不冒充已获批准。
- XPKG-01…09-HOST 是实施时拟登记内容；现行 contract README、生产代码、版本与 CHANGELOG 本轮未修改。

## 基线验证（首轮执行）

| 检查 | 结果 |
|---|---|
| Markdown 本地链接 / 表格列数 / 索引条目覆盖 | 通过；两仓各自索引及跨仓链接完整 |
| core `bun run check` | 退出 0，main / contracts 均通过 |
| core `bun run test` | 退出 0；vitest 819，node:test 489，全通过 |
| core `bun run contracts` | 退出 0；33 passed + 原有 2 todo |
| TUI `npm test` | 退出 0；191 passed |
| TUI `npm run typecheck` | 退出 0 |

日志位于 `/tmp/spec-20261007-{core-check,core-test,core-contracts,tui-test,tui-typecheck}.log`，只记录本次执行，不作为永久依赖。上述是**未改生产代码的基线检查**，不表示 spec 中的新测试、修复或真机验收已经完成。原有 2 个 host todo 与未来 XPKG-09-HOST 待取证项分别记账，不能相互抵扣。


## 独立审查：第一轮发现与修订

用户要求另派 subagent 后，由 `spec_independent_audit` 独立、只读审阅两仓 AGENTS、全部 15 份规格、索引与本记录，并对照生产源码与本地 pi 1.0.1 宿主。主 agent 复核证据后修改规格，未修改生产代码。第一轮结论为“需修订”：**2 项 P1、4 项 P2**。

| ID / 级别 | 发现与触发证据 | 规格修订 / 验收 |
|---|---|---|
| R1 / P1 | hard-link 释放双名窗口：R1 link 后暂停，A 取得 ready，R2 再 link，B 再取得。subagent 用真实临时目录复现两个 live claim；原 queue.ts:107-137,188-206 的替换与 GC 也会直接删除枚举路径 | [P0-3](2026-10-07-p0-3-memory-queue-claim.md) 改为 claim→唯一 pending、死 claim→新 claim 的单次 rename；GC/替换/删除都先取得 token。Q-T5/6/8/10/11 验证竞争、崩溃与迟到删除 |
| R2 / P1 | plan 提前扫描 generic command 会拦截已经授权的 MCP；fusion-tools.ts:23,48-57 对 command/run/cmd 按字段扫描，基线 family 在 index.ts:1443-1457 已提前裁决 | [P0-1](2026-10-07-p0-1-plan-gate-precedence.md) 只豁免权威 MCP shape 且 family 认领的 generic scan，保留内置硬限制与 family deny/ask/allow；T15/16 覆盖业务参数、shell 字符串与 proxy；同步 P2-1 trace |
| R3 / P2 | G3 只改 args→input 会让 echo/read-goal 进入 goal.ts:2183 的误锁分支，新增后续 edit 被拒 | [P0-2](2026-10-07-p0-2-goal-turn-lock.md) 将 G3 与 D3 锁策略绑定；L5 变为首调用→edit 的真实事件序列；仅 CORE-05 独立 |
| R4 / P2 | 用户 D4 只是条件性考虑删除；本地无 TUI 调用不代表已授权删除 package exports 的公开 reader | [P1-1](2026-10-07-p1-1-bus-surface-for-cctui.md) 删除改回待决策提案；未选定保留 reader/exports/测试，instance/footer 可独立；两索引同步 |
| R5 / P2 | TUI off 调 setFooter(undefined)，宿主 interactive-mode.js:1921-1940 恢复 stock；core modes 只在 session_start 安装，不会因 presence=false 自动接管 | core P1-1 / [TUI P0-2](../../pi-claude-code-tui/spec/2026-10-07-p0-2-core-bus-client.md) 明确 off 的 stock 例外；B6/C11 验收两种顺序、off/on、reload 失败的实际槽位，不能只断言 presence |
| R6 / P2 | StatuslineRunner.dispose 清除升级 timer 后只发 TERM（statusline.ts:247-261）；subagent 用真实 runner + 不退出 fake child 观察到只有 SIGTERM | [TUI P0-1](../../pi-claude-code-tui/spec/2026-10-07-p0-1-lifecycle-fixes.md) 新增 dispose 后 TERM→750ms KILL、保留已有截止时间、run token 隔离、零迟到更新；E7/8 覆盖。范围限直接 child，不声称回收任意进程树 |

上述复现只验证规格缺陷；新方案的正式回归用例仍须在实施时完成。没有把第一轮“需修订”改写为原稿通过。

### 修订后定向复审

结论：**R1–R6 均已在规格层关闭，未发现新增阻塞性矛盾。** 同一 subagent 重新核对 7 份受影响规格、两仓索引和本记录。

- R1 第二轮另补 GC token 的独立非记录布局、崩溃回收、预算计数及 Q-T7，避免 GC 自己在 rename 后崩溃留下无法回收的未知文件。subagent 用真实文件操作复核新 rename 交错：第二回收者与第二消费者均得到 ENOENT，最终仅一个 claim。这只证明原语交错，不替代未来完整实现的跨进程验收。
- R2–R6 的扫描边界、实施依赖、D4 决策门、真实 footer 槽位、runner 终止流程与相应测试要求均已闭环；待选的 D3 / D4 / D6 不视为已经批准。
- 最终检查：18 份 Markdown 的本地链接、表格列数与表头、代码围栏、9+6 索引计数通过；本次复审修订涉及 10 份规格/索引文档。两仓 git status 均只有本批 spec 文档，无生产代码或生效契约变更。
- 未重复运行未变化的生产代码全量门禁；首轮基线结果保留于上表。正式修复、回归和真机验收仍未实施。
