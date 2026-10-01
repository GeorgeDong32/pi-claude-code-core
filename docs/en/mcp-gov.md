# mcp-gov — MCP Governance

> English. 中文版: [../zh/mcp-gov.md](../zh/mcp-gov.md)

**Directory**: `extensions/mcp-gov/` — new module (P4-MC)

## What it does

Three duties, assembled in `index.ts`:

1. **Rule family** (`family.ts`): registers the MCP rule family into the
   modes engine — matches `mcp_*`-shaped tools (native / proxy / direct with
   known servers) and evaluates `mcp(server)` / `mcp(server, tool)` rules.
   `canonicalizeMcpTool` here is the **single authority** on "is this an
   MCP-shaped tool" — web-gov reuses it.
2. **Broker mirror** (`broker.ts`): mirrors approval events from the
   pi-mcp-adapter's probed port. Absent adapter → idle, zero side effects.
   The mirror is a synchronous pure function and the canonicalId derives from
   server/tool (not callId) so both sync/async adapter semantics are safe.
3. **`/core` panel** (`panel.ts`): renders core status (modes/effort/goal/
   review/memory/economy) from the bus snapshot, rules included via
   `lib/rule-text.ts`.

## Key surfaces

- **Command**: `/core` panel.
- **Env**: `PI_CORE_MCP_DIRECT_SERVERS` — comma-separated server ids allowed
  to claim bare tool names (e.g. `exa`); native `mcp__…` naming always works.
- **Specificity ladder**: exact rule > server prefix > bare `mcp_*` (S5).

## Invariants & gotchas

- web-gov is assembled BEFORE mcp-gov so URL-carrying calls hit domain rules
  first (P4-WB-01) — preserve the order in `extensions/index.ts`.
- The mirror must stay a pure function of inputs; guard against re-entrancy
  and clean up on `session_shutdown` (C4 fix).
- Direct naming is opt-in per server via env; don't widen it in code.

## Tests

`test/lib/p4-families.test.ts` covers both families' behavior; broker
semantics are additionally pinned in `test/contracts/` (host semantics) and
documented in OPEN-QUESTIONS #6 (true-device verification deferred to P4-REL).
