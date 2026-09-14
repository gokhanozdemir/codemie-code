# 03: Cursor-only empty state when no local token signal

**What to build:** When every session in view is unmeasurable (the common Cursor-only case after deselecting other agents), Overview and Cost KPIs stay on dashes and briefly explain that local token telemetry is absent — so the collapse no longer reads as a broken agent-chip filter. Tool-call and other non-usage panels keep working.

**Blocked by:** 01 — Drop “Included”; unknown cost/tokens are dashes

**Status:** done (commit 0e56e45)

- [x] All-unmeasurable filtered set → Overview Input/Output/Total tokens and Est. cost show `—` (not `$0` / Included)
- [x] A short subtitle or empty-state note states local token telemetry is absent for sessions in view
- [x] Agent chips still filter by agent name only; no model-chip behaviour introduced
- [x] Cursor tool-call success/failure tables remain populated when bubbles carried tool outcomes
- [x] Mixed views that include at least one measured session still show that session’s tokens/cost normally
