# web-gov — Web Rule Family

> English. 中文版: [../zh/web-gov.md](../zh/web-gov.md)

**Directory**: `extensions/web-gov/index.ts` (single file) — new module (P4-WB)

## What it does

The second rule family, and the proof that the family seam is real
(P4-FAM-06):

- Claims search/fetch tools whose input carries a URL-ish value (exa
  search/crawl/fetch, webfetch, …), maps them to the **host**, and evaluates
  `webfetch(domain:host)` rules with deny > ask > allow precedence.
- A builtin pre-approved domain list (P4-WB-02, Claude-Code-style: MDN,
  GitHub, docs.python.org, nodejs.org, …) renders allow without any rule.
- The list is overridable via `~/.pi/agent/pi-core-web.json`.

## Key facts

- Registered via `modes/rule-families.ts#registerRuleFamily`; uses
  `lib/rule-text.ts` for rule text and reuses `mcp-gov/family.ts`
  (`canonicalizeMcpTool`, `directKnownServersFromEnv`) instead of
  reimplementing MCP-shape detection.
- Host extraction is strict: URLs without a usable host (query-only or
  malformed) claim nothing (p4 red→green fix).
- Assembled BEFORE mcp-gov in `extensions/index.ts` so domain rules take
  precedence over `mcp_*` prefix rules for URL-carrying calls (P4-WB-01).

## Invariants & gotchas

- Keep this module single-file; it is deliberately small — the seam does the
  work.
- Preapproved list changes should go through `pi-core-web.json`, not code.
- Only URL-carrying tools are claimed; everything else falls through to the
  mcp family.

## Tests

`test/lib/p4-families.test.ts` (vitest) — claim mapping, host extraction,
deny/ask/allow evaluation, preapproved rendering.
