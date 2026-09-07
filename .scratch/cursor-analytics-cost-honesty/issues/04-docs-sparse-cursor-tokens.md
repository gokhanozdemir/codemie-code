# 04: Docs — recent Cursor bubble tokens are sparse/absent

**What to build:** Operator and integration docs state the verified local reality: recent Cursor builds often write zero (or omit) billable `tokenCount` on bubbles while tool outcomes still appear; the Team Analytics API still does not return token or cost fields; ADR 0001 fail-soft / opt-in external / no silent network constraints remain the contract.

**Blocked by:** None (can start immediately).

**Status:** done (commit db114bc)

- [x] Cursor integration / external-integrations docs mention sparse or absent recent bubble token signals vs working tool enrichment
- [x] Docs restate that Team Analytics endpoints do not provide tokens/cost and cannot alone close that gap
- [x] Docs do not instruct operators to treat “Included” as the expected cost label (aligned with 01)
- [x] ADR 0001 is not contradicted (read-only, fail-soft, Auto display label, no invented invoice certainty)
