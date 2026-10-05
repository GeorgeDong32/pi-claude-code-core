# 对抗性 Code Review — 核心扩展性能与可靠性批(AR1005)

> 范围:`git diff 76e933a..HEAD`(11 项 + 台账/文档,12 commits + 本轮修复)
> 对照:specs/design/2026-10-05-core-architecture-reliability-spec.md §2-§17
> 方法:逐项对照规格验收矩阵(§15)+ 冻结面(§2.1)+ 不变量(AGENTS.md)的定向审查;
> 测试面审计(断言无删改:`git diff` 中被删的 expect/assert 行 = 0);
> 宿主时序声明与证据链核对(§13/§17)。

## R1(P1 — 已修复):ST 强制读与 usage 能力一致性

**发现**:turn_start/turn_end 的强制快照以 `{sessionManager}`(无 `getContextUsage`)调用,
而 `readUsage` 把「能力缺席」标记为 fresh(usage=undefined)。后果链:强制读后
usageFresh=true + 缓存 entry.usage=undefined → 后续 message_update 全部 key-hit
返回缓存 → **真机上整段流式期间 `% ctx` 显示行消失**(基线每次 refresh 都读 usage)。
modes 测试的 fake ctx 无 getContextUsage,故 460 项既有测试全部漏过 —— 典型的
「测试替身能力面窄于真机」盲区。

**修复**:① wiring 侧 `statsHost(ctx)` 单一 host 形状,四个 snapshot 调用点统一
(能力在场性一致);② 模块侧 `readUsage` 能力缺席**不再**置 fresh(一次 typeof,
零宿主调用)—— 无能力读不得为后续有能力的 key-hit 背书;③ 新增回归测试钉住
「强制读后 key-hit 携带 usage」与「无能力强制读不污染后续有能力读」两语义。

**再验证**:check 0 / modes 29 文件全绿 / 全量 55 文件 818+ 测全绿。

## R2(备注 — 不改):ST 的「显式失效 epoch」

规格 §9.2 把「显式失效 epoch」列为 cache key 的一部分。实现以 reset/invalidate/
markDirty 直接清空缓存键(epoch 语义 = 使一切旧键失效)达成同一效果,未采用
「键内递增 epoch 数字」字面形式。语义等价:失效后任何同 leaf/model 组合都必须
重读。记为本实现的等价形式,不构成偏差;若后续引入跨 state 存活的外部键,再
补显式 epoch。

## R3(备注):预存在的时序敏感测试孤发 flake

全量运行中出现一次 `classifier retry loop is bounded to attempts × timeoutMs`
(index.test.ts)失败,后续 3 轮全量 + 定向重跑均不复现。该测试在基线 76e933a
即存在、本批未触碰其代码(diff 为零)。判定:与本批无关的既有偶发时序敏感,
不在本批范围处置(PROGRESS 已披露)。

## 冻结面核对(§2.1)

- bus keys / published types / status·widget 槽 / env 职责:diff 为零 ✓
- bus 快照纪律(无 timer/polling):bus.ts diff 为零;新模块均不触 bus 发布节奏 ✓
- session entry 类型与 pi-memory-recall details v1:字段集未动(details 冻结测试仍绿)✓
- 磁盘布局(.pi/goals、pi-review runs、memory-queue、observation-pack):路径与格式零变更;
  GO-A 明确不加 carryMs 字段(整数 activeSeconds 冻结)✓
- action-fusion 文本 marker / 工具 schema / 执行与抛错方式:then-run.ts diff 为零;
  生产 token 三个原样;fusedCount 仍仅按结构化成功计数 ✓
- lib/settings / lib 不反向依赖 extensions:lib/ 下无新增 extensions import ✓
- effort 写入权威 / rule-family 装配顺序 / MCP shape 权威 / 经济模块探针:零触碰 ✓

## 规格逐项核对(§3-§12 验收行)

| 项 | 关键断言核对 | 结论 |
|---|---|---|
| JS | T01-T08 全落地;T07 操作数 seam;§15 benchmark 0 span 扫描 | ✓ |
| RC | T01-T10 机器级 + T09a/b/c wiring + 契约 ⑦ 真实 runner;unhandledRejection 隔离子进程 | ✓ |
| AU | T01-T06 调用序列断言(prompt 计数、dispose 恰一次、goal 保持 active);7 项基线红 | ✓ |
| FU | T01-T07 真实 executeMutationThenRun 产物 + render facts;契约 ⑧ 编译期钉 | ✓ |
| GO-A/B | T01-T10;8×250ms 基线红 0≠2;每事件解析数 4→3、1/10/100 goal N 解析 | ✓ |
| RU | T01-T08;基线红 18036≤8000;重入不双花;契约 ⑨ todo(§13.2 协议) | ✓(宿主顺序 fact 待人工) |
| ST | T01(0/0 宿主读)/T02/T03(真实 SM)/T05/T07;R1 修复后回归钉;契约 ⑩ 执行 + ⑪ todo | ✓(宿主顺序 fact 待人工) |
| OB | T01/T02/T03/T05/T07;构造数 1@51 请求;ledger 每次替换仍写 | ✓ |
| RV | T01-T06 真实 prepareRun + 受控 clone;基线红 5/6 | ✓ |
| CL | 死读删除,引用检查零消费;93 项既有回归绿 | ✓ |

## 测试面完整性

- 被删除的 expect/assert 断言:0(diff 审计)✓
- 基线红证据:每项以 stash 于基线执行并记录于 commit message 与 DEVIATIONS #98-108 ✓
- 契约登记先于测试:AR1005-{ST,RC,RU,FU}-HOST 四行先入表(含 2 项 §13.2 todo + 人工步骤)✓
- todo 逃生门:⑨/⑪ 带去向(用户真机会话执行注释内步骤),非静默丢弃 ✓

## 台账一致性(§16)

headers(recall/index/flow/auditor/accounting/activation/working-stats/projection/store/
review-run)✓;docs en/zh 八模块同步 ✓;CHANGELOG Unreleased 六段(含 R1 后补)✓;
DEVIATIONS #98-108 ✓;PROGRESS 批次条目 ✓(R1 修复与 R3 备注 已补记)。

## 结论

**R1 修复后:ACCEPT**(附 R2/R3 备注)。三门最终态:check 0 / test 55 文件全绿 ×
多轮 / contracts 31+2 todo 0。宿主时序遗留两项按 §13.2 协议显式 open(实现双保险,
正确性不依赖;人工步骤在契约文件注释内,PROGRESS 已披露)。
