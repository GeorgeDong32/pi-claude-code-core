# B4 Recon Report: MCP tool-declaration token cost, measured (2026-10-20)

Method: a probe extension hooks `before_provider_request` and dumps the real
provider request's tools array per-tool declaration bytes (headless
`pi -p "say hi" -e /tmp/decl-probe.mjs`; current config: one exa server,
exposure: direct). Tokens estimated ÷4.

## Measured numbers (current config, 25 tools)

| Class | Tools | Decl bytes | ≈tokens | Share |
|---|---|---|---|---|
| **MCP (exa, exposure: direct)** | 3 | **5,370** | **≈1,343** | **19.3%** |
| Built-ins (read/bash/edit/write/codemode/subagent/…) | 8 | 12,857 | ≈3,214 | 46.0% |
| core extensions (goal/review/memory/bg-shell/observation/subagent) | 11 | 9,698 | ≈2,425 | 34.7% |
| **Total** | 25 | 27,925 | ≈6,981 | 100% |

MCP detail: `mcp__exa__agent_run` 3,152B (≈788 tok) > `mcp__exa__web_search_exa`
1,459B (≈365) > `mcp__exa__web_fetch_exa` 759B (≈190) — the bulk is schema +
marketing-length descriptions.

## Verdict (threshold: ≥1K tokens/server → go)

- **exa alone ≈ 1,343 tokens > 1K → GO.**
- This is PER-REQUEST input volume (the tools parameter ships with every
  provider request; cached reads still cost). A long session multiplies it
  by request count.
- Multi-server configurations stack linearly (~1K+ tokens per direct
  server).
- Complements observation-pack (output side) — B4 closes the input side.

## Direction (per parent spec §B4: mcp-gov declaration diet on pi's native five exposure tiers — no new mechanism)

1. **Visibility**: the /core panel (mcp-gov) gains a per-server declaration
   bytes/token row — the bus mirror already sees the tool list.
2. **One-keystroke exposure switch**: panel/command toggles direct ↔
   codemode (writes ~/.pi/agent/mcp.json's exposure field + restart hint) —
   codemode drops the entire server declaration (pi's native deferred
   machinery serves on-demand calls).
3. *(Optional tier 2)* Description diet for retained direct tools
   (>1KB truncated to first sentence + parameter summary) — deferred this
   batch; revisit with measured savings.

## Upstream facts relied on

- pi's native five exposure tiers: codemode (callable, not declared) /
  codemode-deferred / deferred / direct / hidden — the `exposure` field in
  ~/.pi/agent/mcp.json is the switch.
- The exa declaration persists even with an expired token (direct
  declarations do not depend on connection liveness) — these numbers are
  steady-state.
