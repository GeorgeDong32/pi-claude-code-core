# ui — 呈现适配层

> 中文版。English: [../en/ui.md](../en/ui.md)

**目录**:`extensions/ui/`(另有各模块自己的包装,如
`extensions/modes/ui/`、`extensions/effort/ui/`)

## 做什么

业务模块与呈现之间的解耦层(DECOUPLE-PLAN §4.2,DC2 冻结)。业务模块做
*呈现*时绝不直接碰 `ctx.ui`——它们只发布状态,由适配器渲染。

## 适配器接口(`ui/base.ts`)

两个适配器共同满足的唯一呈现接口:

- `startup()` / `shutdown()` —— 适配器生命周期(挂载/卸载 widget)。
- `onSnapshot(snapshot)` —— 接收冻结总线快照。两项职责:渲染持久状态;
  按 `lastSeenId` diff `notifications`(有界尾队列,§4.1)。渲染必须幂等。

接口形状刻意冻结:每个方法都是调用方必须学习的事实——不要随手扩充。
交互表面(select / editor / onTerminalInput)不在这里——它们留在各模块的
ui 包装后(如 `effort/ui`),业务流因此可以对 fake await。

## 适配器

| 适配器 | 文件 | 说明 |
|---|---|---|
| cctui(优先) | 外部(pi-claude-code-tui) | 在场时负责渲染;经 globalThis 上的 presence 键检测 |
| core 兜底 | `ui/fallback.ts` | 「无 cctui 的 core」的瘦默认:持有 working 消息行与通知尾队列显示;每次写入前读 presence 键向在场的 CC-TUI 让位(轮询点自愈——过期键在每次快照时重读) |
| notify | `ui/notify.ts` | 模块共享的通知入口(喂尾队列) |
| footer-lines | `ui/footer-lines.ts` | 多来源 `display.footer` 发布器(XPKG-07,2026-10-07 P1-1):每个 bus 实例一份 `Map<source, line>`(WeakMap——reset/reload 不沿旧行),单次 patch 发布按 source 排序的整体数组;删除最后一行时显式发布空数组 |

## 不变量与坑

- 模块代码发布;适配器渲染。若发现模块为画持久状态而直接调 `ctx.ui`,
  把它挪到适配器后面。
- presence 检测必须在每次快照时重查(不缓存)——这正是自愈属性。
- 通知 id 单调递增;消费方按 `lastSeenId` diff。

## 测试

`test/lib/fallback-adapter.test.ts`、`notify.test.ts`(vitest);effort 的
适配器交互另见 `extensions/effort/tests/ui.test.ts`;effort 的「恰好显示一次」
合同(真实入口 + 真实 bus + 真实 fallback 适配器,含旧 cctui 直写分支与
off/on 交接)由 `extensions/effort/tests/notify-display.test.ts` 钉住。
