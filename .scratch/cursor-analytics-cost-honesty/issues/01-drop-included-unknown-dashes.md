# 01: Drop “Included”; unknown cost/tokens are dashes

**What to build:** The analytics HTML report never presents subscription wording for missing usage. Cost and token cells for unmeasurable sessions show an em dash. Mixed groups still show the sum of whatever was measured. Session-modal copy no longer says usage was covered by a subscription.

**Blocked by:** None (can start immediately).

**Status:** done (commit 0e56e45)

- [x] No cost-formatting path in the report client emits the string `Included`
- [x] Unmeasurable sessions render `—` for cost and for token fields (not `$0.00` / `0`)
- [x] Aggregates over a mixed measured+unmeasurable set still show the measured sum
- [x] Session modal cost subtitle no longer says “covered by subscription”
- [x] Regenerating a report with `--include-external` and filtering to Cursor-only shows dashes for cost/tokens, not Included
- [x] Non-Cursor agents’ measurable totals are unchanged for the same underlying sessions
