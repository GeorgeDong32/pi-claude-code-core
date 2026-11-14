# 深度 Code Review — extensions/review 模块(FX-5,2026-11-14)

> 范围:`extensions/review/` src(17 文件,~4,100 行)+ tests(12 套件,~3,500 行),base 2f25dfe,
> 审查时 HEAD 已含本批 FX-1 修复(4a8145d)。
> 方法:全量逐文件通读(非 diff 抽查)+ 调用点 grep 审计(runCmd 全部 call site、
> workflow-schemas 引用面、bus 发布面)+ 对照契约冻结面(P0-CT-08/09)与既有测试钉。
> 规则:每条发现 file:line + 证据 + P0–P3;确认 P0/P1 本批先失败测试后修复;P2/P3 只记录。
> 熔断:P0/P1 >5 或需动契约面/跨模块 → 停止上报(未触发)。

## 结论速览

| 严重度 | 条数 | 处置 |
|---|---|---|
| P0 | 0 | — |
| P1 | 1 | 本批已修复(R1,先红后绿) |
| P2 | 2 | 记录,列入下一轮(R2、R3) |
| P3 | 9 | 记录(R4–R12) |

FX-1 移交裁决的「PR 路径命令是否也需要时限」:**确凿风险成立,本批已修**(R1)。

---

## R1(P1 — 本批已修复):PR 路径全部子进程命令无时限、无凭据提示抑制,/review 可无限挂起

**发现**(FX-1 明确移交本项裁决):D-FX-1 只给本地 base fetch(`git fetch origin <base>`)加了
15s 上限;PR 路径的 5 个子进程调用仍无时限:

- `extensions/review/src/target-workspace.ts` — `gh repo clone`(修复前 :77-81)、
  https `git clone --depth 50` 兜底(:82-83)、`git fetch origin pull/<n>/head`(首次 :96-100、
  TOCTOU 重试 :174-178)。
- `extensions/review/src/review-run.ts` — `gh pr view <ref> --json …`(修复前 :264-267)、
  `gh pr diff <ref>`(:289,单一 diff 权威)。

**证据/场景**:(a) 私有仓库 + gh 不可用/未认证时,https 兜底 clone 会弹出
username/password 终端提示 —— 调用点未传 `GIT_TERMINAL_PROMPT=0`,git 无限等待凭据输入,
/review 永远停在「review running」;(b) 网络僵死时 clone/fetch/gh API 同样无界挂起
(D-FX-1 spec 原文承认的同一失败类:「网络卡住或 git 等待凭据输入时 /review 无限等待」,
只是当时明确把 PR 路径留给 FX-5)。clone 失败路径本就是硬错误(throw),所以加时限
语义安全:超时经同一既有硬错误路径浮出,stderr 带 "timed out"。

**修复**(本批,先红后绿):`run-cmd.ts` 的 `timeoutMs`/`env`(FX-1 已建)直接接线 ——

- target-workspace.ts:`PR_CLONE_TIMEOUT_MS = 120_000`(两条 clone 路径)、
  `PR_HEAD_FETCH_TIMEOUT_MS = 60_000`(两次 pull/<n>/head fetch),全部附
  `GIT_TERMINAL_PROMPT: "0"`;gh 会把 env 透传给内部 git。
- review-run.ts:`PR_GH_TIMEOUT_MS = 60_000` 施于 `gh pr view`(元数据,失败本就非致命)
  与 `gh pr diff`(权威,失败走既有 throw,超时文案可见)。
- 红基线:HEAD 4a8145d 上新增 4 测,2 条 opts 断言红(clone/fetch/gh 调用无 timeoutMs/env)、
  2 条超时文案钉在 base 即绿(它们钉的是接线后的错误路径形态);修复后 41/41 绿。
- 常量硬编码、不可配置(与 D-FX-1/INV-10 一致);未触及 review 模块之外。

**复核审计**:修复后 review 模块全部 runCmd call site 均有时限或确证无需 ——
本地 `git status/diff/ls-files/rev-parse/symbolic-ref/merge-base` 是快速本地命令
(无网络、无凭据提示面),不需要时限;有网络/有挂起面的 7 个调用点
(本地 base fetch、2×clone、2×pull fetch、2×gh pr)现已全部封顶。

## R2(P2 — 记录):内层 SHA 校验在「重试 fetch 失败」时静默放行

`extensions/review/src/target-workspace.ts:174-184`:`FETCH_HEAD ≠ expectedHeadSha` 触发一次
重试 fetch,但守卫是 `if (retryHead && retryHead !== expectedHeadSha) throw` ——
重试 fetch **失败**时 `retryHead === ""`,守卫不触发,流程继续 checkout 已知不匹配的
旧 FETCH_HEAD。正确性由外层兜底保住(review-run.ts 的 outer TOCTOU:workspaceHeadSha 与
diff head 不匹配 → 删 clone 重试一次 → 仍不匹配则 throw,有测试钉住),但内层
「快速失败、省一次 clone」的意图丢失,失败场景多付一次完整 clone。下一轮可改为
`retry.exitCode !== 0 || retryHead !== expectedHeadSha` 同样 throw。

## R3(P2 — 记录):untracked 文件无大小上限读入,巨大文件可撑爆 diff

`extensions/review/src/review-run.ts:326-350`:脏树路径对每个 untracked 文件
`readFileSync(join(cwd, f))` **全量读入**后才做 8,000 字节二进制探测
(:336 `buf.subarray(0, 8000).includes(0)`),文本文件全文内联进 diff
(:343-348 无截断)。一个几百 MB 的未跟踪日志/构建产物会:全量进内存 → 全文写进
`change.diff` → sha256 → 指示评审者去读这个巨型 diff。建议下一轮:statSync 大小上限
(如 1 MB)+ 超限替换为占位 hunk 并在 coverage.limitations 说明。

## R4(P3 — 记录):`src/workflow-schemas.ts` 整文件死代码,且文件头断言与 v0.8 设计相反

全仓 grep:`REVIEWER_OUTPUT_SCHEMA`/`GATE_OUTPUT_SCHEMA`/`serializeSchema*` 无任何
importer(src、tests、docs 均无)。而其头注释(:2-6)声称 schema「injected as
outputSchema on each reviewer and the gate」「The plugin no longer reads reviewer
Markdown text」—— 与 v0.8 现实完全相反(directive.ts:303-306:子任务不再带
outputSchema;markdown 报告就是数据源)。`docs/{en,zh}/review.md` 内部地图仍把它列为
活的「Reviewer/gate output schemas」。下一轮:删文件 + 修两张 docs 表。

## R5(P3 — 记录):config.ts 头注释的配置路径与代码/契约不一致

`extensions/review/src/config.ts:5` 头注释写「user-editable config lives at
`~/.pi/agent/extensions/pi-review/config.json`」,而同文件 :90(及契约
test/contracts/disk-layout.test.ts P0-CT-09)钉的是 `~/.pi/agent/pi-review.json`。
误导性文档漂移(代码/契约是对的)。另注(模块外,只提示):仓库根 AGENTS.md 磁盘表把
`pi-review.json` 列在 `<cwd>/.pi/pi-review/` 下,与契约路径不一致,建议由台账统一改。

## R6(P3 — 记录):directive.ts 冗余解析守卫 + 死变量/死导出

`extensions/review/src/directive.ts:178` 与 `:243` 是两段完全相同的
`new Function(...)` 解析守卫(script 在两者之间不可变,第二段永远通过,白付一次编译);
`:65` 解构出的 `cwd` 未被使用;`:487-488` `_LEGACY_PARITY` 为死导出(仅 `void` 自引用)。

## R7(P3 — 记录):review-report.ts 未用导入/接口与多余 void 存活语句

`extensions/review/src/review-report.ts:9`(`spawn` 未用)、`:10`(`type RunCmd` 未用)、
`:131`(`void safeStat;` 冗余 —— safeStat 在 pruneStaleRuns 里实际在用)、
`:219`(`void PR_REF_REGEX;` 冗余 —— parsePrRepo 在用)、`:139` `GhExec` 接口无消费者、
`:246` `_INTERNAL` 导出无消费者。均为 P3-1 S1 三合一迁移后的残留。

## R8(P3 — 记录):legacy 旗标无条件吞掉下一个 token,可吞掉真旗标

`extensions/review/src/cli-args.ts:45`:`--threshold/--reviewer/--score-per-issue/--diff`
一律 `i++` 吞掉「下一个 token」,即使那是另一个旗标 —— `/review --diff --lite` 会把
`--lite` 当作 `--diff` 的值吞掉,lite 模式静默丢失。属文档化的优雅降级怪癖,低频;
下一轮可加「下一 token 以 `--` 开头则不吞」的例外。

## R9(P3 — 记录,by design):裸 `pull/N` 启发式可把散文劫持成 PR 目标

`extensions/review/src/pr-ref.ts:27`:`/\bpull\/(\d{1,10})\b/i` 对自由文本生效 ——
`/review 解释一下 pull/42 的处理逻辑` 会被解析为当前仓库 PR #42
(`gh pr view 42` 对当前 repo 取 PR),把一般性请求变成错误目标的评审。
pr-ref.test.ts 把该行为钉为 CC-style 设计;风险记档,不改设计。

## R10(P3 — 记录):toolBudgetForReviewer 无消费者,与 directive 内联逻辑重复

`extensions/review/src/lean-agents.ts:62` 的 `toolBudgetForReviewer` 无调用方;
directive.ts:349 内联了同一 `history-context` 特例分支。两处规则若日后只改其一即漂移。
下一轮:directive 改调该函数或删除它。

## R11(P3 — 记录):bus `review.status="running"` 无对账路径

`extensions/review/index.ts:143` 在 directive 注入前发布 `running`;`done` 只能由
`pi_review_report` 工具发布(tool-wrapper.ts:65)。workflow 失败、用户中止回合或
main agent 从未调用该工具时,review 通道停在 `running` 直到下一次运行的 done。
仅影响 UI 状态陈旧,不涉及数据正确性。可考虑 session_start 或下次 /review 前对账。

## R12(P3 — 记录):`--no-spawn` 干跑并非「无子进程」:PR 目标仍会完整 clone

cli-args.ts 头注释称 `--no-spawn` 为「prints the resolved plan, no subprocess」,
index.ts:130 的 renderDryRun 走真实 `prepareRun`(仅 `cleanup: false` 跳过修剪,
index.ts:268):PR 目标仍执行 gh/git clone 并落 run 目录 + clone 工作区,靠 24h TTL
由下一次真实 /review 回收。行为命名误导;下一轮要么让干跑对 PR 目标走无 clone 的
元数据路径,要么改注释明说。

---

## 冻结面核对

- session entry 类型(`pi-review` / `pi-review-directive`)与磁盘布局
  (`~/.pi/agent/pi-review.json`、`<cwd>/.pi/pi-review/runs/<id>`):本批零触碰,
  契约 P0-CT-08/09 全绿 ✓
- bus 纪律:`running`/`done` 发布点均在同步事件处理器内,无 timer/polling ✓
- `lib/` 无新增 extensions 依赖;FX-5 修复只动 extensions/review/** ✓
- 金丝雀(ObservationPack 占位符 + then_run 融合):5/5 绿 ✓

## 本批门槛(FX-1 + FX-5 修复后)

- `bun run check`:main OK;contracts OK
- `bun run test`:vitest 84 文件 1209/1209;node:test 九目录
  108+262+183(review,含新增 run-cmd 6 + D-FX-1 2 + FX-5 4)+21+33+278+136+37+19,
  零失败(BH-10 关闭)
- `bun run contracts`:108 passed / 4 todo(18 文件)
- 金丝雀:5/5

## 收尾

- R1 修复(代码 + 4 测)与本报告分开提交:`review(fx-5): …` ×2。
- P2/P3(R2–R12)移交下一轮,不在本批扩面。
