# 07: Keep Team Analytics admin-only; stop presenting it as the member path

**What to build:** Retain the opt-in Cursor Team Analytics pull for **enterprise team admins** who have an admin-scoped API key, but make the product surface unmistakable: members without admin access cannot use it and should use the usage CSV path (09) instead. Remove or rewrite any copy that implies a non-admin `crsr_` / Team Analytics key closes tokens/cost for ordinary team members. Do **not** delete the admin feature unless docs/CLI currently claim members can use it for billable usage — in that case fix the claim, keep the gate.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `--cursor-team-analytics` + admin API key remain available for enterprise **admins**
- [ ] CLI help, flag description, and empty-state copy state clearly: **enterprise team admins only** — not for ordinary team members
- [ ] Members who lack an admin key get a clear message pointing at usage CSV import (09), not a auth-failure dead end framed as “set CURSOR_TEAM_ANALYTICS_API_KEY”
- [ ] Team Analytics section (when present) stays labelled as admin/team-API aggregates and still does **not** claim to supply per-session billable tokens/cost
- [ ] No silent network calls without both flag and credential (existing gate preserved)
- [ ] User-scoped `by-user` filter behaviour for the admin pull is unchanged unless already wrong
