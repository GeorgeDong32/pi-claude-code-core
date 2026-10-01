# 总体架构

> 中文版。English: [../en/architecture.md](../en/architecture.md)

## 一个包,一条装配流水线

pi 对每个 manifest 条目只加载一个工厂。`extensions/index.ts` 默认导出装配
函数,按固定顺序对同一个 `ExtensionAPI` 实例依次调用各模块工厂:

```
bus → modes → effort → goal → review → rules → memory → web-gov → mcp-gov → economy(action-fusion, observation-pack)
```

顺序在两处有讲究:

- **web-gov 先于 mcp-gov** —— 携带 URL 的工具调用必须先命中域名规则族
  (`webfetch(domain:host)`),未命中才落入 MCP 族的 `mcp_*` 前缀规则。
- **economy 模块最后** —— observation-pack 必须占据最终的 `context` 投影槽
  (在 modes/memory 处理器之后);action-fusion 的注册顺序虽与位置无关,
  也固定在此以保证确定性。

## 两个层次

```
lib/                  extensions/
共享原语               模块,一目录一模块
(禁止反向依赖)          (可 import lib/,反向禁止)
```

- `lib/` 存放跨模块原语:settings JSON、overlay 选择器、model-id 解析器、
  rule-text 助手、effort 所有权、上下文预算、economy 开关、pi 兼容性探针。
  按规则自包含——需要扩展形状数据的助手用结构化类型。
- `extensions/` 存放十二个模块。模块间通过两条许可的接缝通信:**直接
  import**(如 effort/modes 引 `lib/effort-owner.ts`;web-gov 复用
  `mcp-gov/family.ts`)与**能力总线**(只读状态)。

## 能力总线

`extensions/bus.ts` 发布 `globalThis.__piClaudeCodeCore`:冻结的纯数据快照,
revision 单调递增,只在 pi 事件处理器内做整快照替换。legacy 键
(`__piPermissionModes`、`__pmWorkingStats`)在同一同步批次内派生,旧消费方
与新快照永不打架。消费方:CCTUI ≥1.5.0、pi-agent-panel,以及 core 自己的
UI 适配器。发布形状在 `types/`(JS + 手工维护的声明孪生,由
`test/lib/bus-types.test.ts` 守护形状一致)。

详见 [bus.md](bus.md)。

## 模块地图

| 模块 | 来源 | 一句话 |
|---|---|---|
| `modes` | @georgedong32/permission-modes 2.8.0 | ask/plan/auto/bypass 权限引擎、分类器、审批转发 |
| `effort` | @georgedong32/pi-effort 0.1.2 | 思考档位所有权链、/effort /fast、alt+t |
| `goal` | capyup/pi-goal 0.6.0 fork | goal 生命周期工具/命令、sisyphus 循环、完成度审计 |
| `review` | @georgedong32/pi-review 0.8.6 | /review 扇出流水线、pi_review_report 工具 |
| `rules` | 新写(P3) | 仓库规则文件 → system prompt 注入,/rules |
| `memory` | 新写(P3) | 双层记忆、注入、写保护、整合、导入 |
| `web-gov` | 新写(P4) | webfetch(domain:host) 规则族 + 预批准域名 |
| `mcp-gov` | 新写(P4) | MCP 规则族、broker 镜像、/core 面板 |
| `action-fusion` | NVlabs/SoL-Pi 移植 | write/edit + `then_run` 同轮融合 |
| `observation-pack` | NVlabs/SoL-Pi 移植 | 大工具结果 → 占位符 + obs_recall 翻页 |
| `bus` | 新写(P1) | 能力快照 |
| `ui` | 新写(DC5) | 呈现适配器:cctui 优先、core 兜底 |

## 横切不变量

1. `lib/` 不 import `extensions/`。
2. `lib/effort-owner.ts` 是唯一的 `pi.setThinkingLevel` 调用点。
3. 总线发布:同步、冻结、整快照、revision 单调。
4. 规则族经 `modes/rule-families.ts` 注册;web-gov 装配在 mcp-gov 之前;
   `canonicalizeMcpTool` 是 MCP 形态的唯一权威。
5. 上下文预算切分:rules 40K / memory index 25K / dynamic steer 8K
   (`lib/context-budget.ts`)。
6. 注入/投影边界 fail-open;economy 模块经 `lib/pi-compat.ts` 探针降级,
   不阻塞会话。
7. 契约钉住的表面(globalThis 键、env 变量、status 槽、session entry
   类型、磁盘布局)只能走 `test/contracts/README.md` 的契约表规程变更。

## 演进模型

本包由四个前身包(pm / pi-effort / pi-goal fork / pi-review)分阶段迁移
而来,每次迁移由契约套件钉住、断言零改动。spec 在父工作区 `../specs/`
(P0 脚手架 → P1 modes/effort/bus → P2 goal/review → P3 rules/memory →
P4 mcp-gov/web-gov,另有 0.2.0 吸收 SoL-Pi economy 的 SPEC 2026-09-29)。
与 spec 的偏差记入 `DEVIATIONS.md`;各模块实施状态见 `PROGRESS.md`。

## 测试模型

- **vitest**:`test/lib/`(lib 单元 + 跨模块接线)与 `extensions/modes/`
  (就近 `*.test.ts`)。
- **node:test 经 tsx**:`extensions/{effort,goal,review,action-fusion,
  observation-pack}/tests/` —— 各包保留迁移时的框架。
- **契约**(`bun run contracts`):`test/contracts/` 钉住跨包表面;内含
  pi 宿主语义套件(`pi-host-semantics.test.ts`),pi 升级破坏被依赖行为时
  第一个亮红灯。
- **tsc 门**(`bun run check`):两个 project,主工程 + 契约工程。

一律通过 script 入口运行(`bun run check|test|contracts`);不要直接调
vitest/tsc。
