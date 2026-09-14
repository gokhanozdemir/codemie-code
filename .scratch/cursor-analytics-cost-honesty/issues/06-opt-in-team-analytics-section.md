# 06: Opt-in Cursor Team Analytics section (non-token aggregates)

**What to build:** An optional, explicitly flagged, credential-gated pull of Cursor Team Analytics for the requesting user only, rendered as a separate labelled section in the analytics report. Shows only what the API actually returns (edits, models, etc.). Never merges into the local session table, never makes silent network calls, and never fabricates tokens/cost from this API.

**Blocked by:** 05 — Research spike — alternate recent Cursor billable-token sources

**Status:** done — but re-scoped by GitHub #23: Team Analytics is enterprise-ADMIN-only and is not the member path to tokens/cost. Members use `--cursor-usage-csv` (#21). This ticket is retained as historical; it should not be read as "Team Analytics answers cost". — keep for enterprise admins; members use CSV (09/10). Clarify audience via 07/08.

- [x] No Team Analytics network call runs unless both a configured credential and an explicit invocation opt-in are present
- [x] Data scope is the requesting user’s own email (`by-user`); no team-wide or leaderboard dump into personal analytics
- [x] Report renders Team Analytics in a separate labelled section, not inside the local session rows
- [x] Local session table and Team Analytics section are not silently joined on missing composerId keys
- [x] Tokens/cost are not invented from Team Analytics responses
- [x] Fail-soft: API/auth failures degrade to an empty/omitted section without breaking the local report
- [x] Behaviour respects conclusions from 05 (e.g. if a better token source was found, this ticket still does not pretend Team Analytics supplies tokens unless upstream changed)

Audience clarification 2026-09-05: **retain** this feature for enterprise **team admins** only. Ordinary members cannot use the admin API key path for billable usage — they use dashboard usage-events CSV (tickets 09/10). Tickets 07/08 update product copy and docs; do not delete the admin opt-in.
