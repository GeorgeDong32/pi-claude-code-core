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
- Host extraction parses URL fields with `new URL()` (BH-S2): the hostname
  is lowercased with trailing dots stripped. A URL carrying userinfo
  (`user@host`) is NEVER treated as preapproved — explicit `domain:` rules
  still match the real host, otherwise it asks. A URL field that is not a
  parsable absolute URL fails closed to ask (the old prefix regex stopped
  at `@` and accepted schemeless hosts, so `https://github.com@evil.example/`
  rode the preapproved github.com entry). A free-text `query` still claims
  nothing (a search term is not a fetch target). IP literals are hosts:
  `domain:` rules match them normally, but the preapproved list never
  matches an IP. URLs that fail URL parsing fall back to ask — an explicit
  domain deny degrades to ask for such inputs (fail-closed; only an
  exact-string grant can allow them). The first-seen prompt may render the
  internal marker form (`Allow ?github.com/docs?` for unparsable input,
  `Allow @evil.example?` for userinfo); the persisted suggested rule is
  the clean host rule for userinfo and the exact raw-string rule for
  unparsable input.
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
`extensions/web-gov/tests/bh-s2-host.test.ts` (node:test via tsx) — the
BH-S2 host-parsing contract: userinfo, IP literals, trailing-dot
normalization, fail-closed unparsable fields, and the marked-id rule
grammar.
