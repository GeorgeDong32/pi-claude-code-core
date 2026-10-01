# bus — 能力总线

> 中文版。English: [../en/bus.md](../en/bus.md)

**文件**:`extensions/bus.ts`(发布类型在 `types/`)

core 模块与外部消费方之间唯一的状态通道。

## 形状

- `globalThis.__piClaudeCodeCore` → `CoreSnapshot`:**冻结的纯数据**——
  version、单调 `revision`,以及各模块通道:`modes`(mode、planPhase、
  workingStats、meta)、`effort`(level + source)、`goal`、`review`、
  `notifications`(有界尾队列,上限 20,id 单调)、`display.footer`、
  `contextBudget`、`memory`、`observation`、`fusion`。
- legacy 键 `__piPermissionModes`、`__pmWorkingStats` 在同一同步批次内从同一
  快照派生——与新快照永不矛盾。
- v2 扩展点:`snapshot.onChange(fn)` —— **数据式**订阅字段,带版本门控;
  不要另起事件系统。

## 纪律

- **只在 pi 事件处理器内发布**,中间不得有 `await` 断点(单线程原子性)。
- 整快照替换 + `Object.freeze` + revision 单调递增。
- 无定时器、无轮询。
- 读取方使用 `types/` 中的全函数 `readCoreStatus()`(对任意 globalThis 形状
  安全,返回完整的 `CoreStatus`)。

## 类型发布

`types/index.d.mts` 是 `types/core-status.mjs`(经 `./types` 子路径导出)的
手工维护声明孪生。与 `extensions/bus.ts` 的形状一致性由
`test/lib/bus-types.test.ts` 守护——两侧必须一起改。

## 消费方

CCTUI ≥1.5.0、pi-agent-panel,以及 core 自己的 UI 适配器
(`extensions/ui/`)。legacy 键服务 CCTUI <1.5.0 与旧面板;移除条件钉在
契约表中。

## 契约

P0-CT-01..06(legacy 键、shutdown 语义、继承模式 env)、P1-BUS-05(core
快照 + legacy 同步)、P0-CT-07(status 槽)。见
[test/contracts/README.md](../../test/contracts/README.md)。

## 测试

`test/lib/bus.test.ts`、`bus-channels.test.ts`、`bus-types.test.ts`、
`coexistence.test.ts`(vitest)。
