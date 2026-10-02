# action-fusion — 变更 + then_run 同轮融合

> 中文版。English: [../en/action-fusion.md](../en/action-fusion.md)

**目录**:`extensions/action-fusion/` —— economy 模块,移植自
NVlabs/SoL-Pi(MIT),SPEC FUS-01..11(0.2.0 吸收)

## 做什么

把一次文件变更与其后续命令融合进同一个模型 turn:内置 `write`/`edit` 工具
被重新注册,新增可选 `then_run` 对象参数(`{ command }`)。执行委托给内置
实现,随后命令经内置 bash 工具运行(完整继承权限管线),并合并输出。

## 语义

- 标记语义保持完全一致:后续命令成功则附加 `then_run` 输出;变更失败或
  非零退出路由到 `[then_run:failed]` / `skipped` 形状。
- 指引双通道:`then_run` schema + 工具描述尾部。
- 渲染直通内置渲染器——零新增渲染表面(CMP-03)。TR 徽标只做加法:融合调用下方包一行 `↳ then_run: <command>`,结果按 marker 只读扫描出着色状态行(`✓ ok` / `✗ failed` / `⊘ skipped`);普通 write/edit 渲染逐字节不变(零包装规则)。

## 队列规则(重要)

模块使用自己的融合逐文件队列(`file-queue.ts`、`withFusedFileQueue`)作为
**外层**。官方 `withFileMutationQueue` 不能当外层——它会与内置工具自带的
队列重入死锁(沙箱实证)。不要把它「简化」回去。

## 开关与兼容

- `~/.pi/agent/core-economy.json` → `actionFusion: bool`(缺省 true;文件
  畸形时降级为默认值 —— `lib/core-economy.ts`)。
- `lib/pi-compat.ts` 探针(版本 ≥0.87.0、工具工厂、mutation 队列)门控本
  模块;降级只警告、不阻塞。
- **总线**:`fusion` 通道 —— `{ fusedCount }`。

## 文件

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配:重注册 write/edit、指引、执行合并 |
| `then-run.ts` | `createThenRunSchema`、`executeMutationThenRun`、退出形状逻辑 |
| `tool-path.ts` | `resolveToolPath`、`normalizeToolPath`(路径知识,arch B6) |
| `file-queue.ts` | `withFusedFileQueue`(外层队列) |

## 测试

`extensions/action-fusion/tests/then-run.test.ts` —— node:test 经 tsx。
