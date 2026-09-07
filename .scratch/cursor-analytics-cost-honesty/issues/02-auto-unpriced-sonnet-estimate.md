# 02: Auto/unpriced token sessions get Sonnet-equivalent estimates

**What to build:** When a session has recoverable tokens but the model cannot be priced (Auto, default, unknown, or otherwise missing from the price table), the report shows an API-equivalent USD estimate using the documented Claude Sonnet rate stand-in, keeps the original model label on the session, and marks the usage as partial. Sessions whose tracking model already prices normally keep using that model’s rates.

**Blocked by:** None (can start immediately).

**Status:** done (commit 4630ca6)

- [x] Tokens + Auto/unpriced model → nonzero USD estimate, `usagePartial` set, displayed model still Auto/original (not renamed to Sonnet)
- [x] Tokens + priced model (e.g. a real tracking-db id) → that model’s rates; Sonnet fallback not applied
- [x] No token signal → no fabricated estimate; provenance stays unmeasurable (dashes after 01)
- [x] Partial badge / copy still indicates the figure is understated or estimated
- [x] Coverage still treats “had recoverable usage” as priced when tokens were adopted from adapter provenance
- [x] Verifiable via enricher/native Cursor fixtures without requiring a live `state.vscdb`
