# 08: Docs — admin Team Analytics vs member usage CSV

**What to build:** Update operator and guide docs so the two Cursor remote/export paths are explicit and non-overlapping:

1. **Enterprise team admins** — optional `--cursor-team-analytics` + admin-scoped API key for Team Analytics aggregates (edits/models/etc.; not the billable token ledger).
2. **Team members (and anyone without admin API access)** — download Cursor Usage events CSV and pass it via the file flag (09); optional cookie fetch later (10).

Underline that `Kind=Included` in the CSV is a billing category and rows still carry tokens and `Cost`. Keep report UI honesty: never use “Included” as the cost cell label.

**Blocked by:** 07 — Keep Team Analytics admin-only; stop presenting it as the member path

**Status:** ready-for-agent

- [ ] `docs/ANALYTICS-REPORT.md` documents **two** paths with audience labels: Admin → Team Analytics; Member → usage CSV
- [ ] `docs/CURSOR_INTEGRATION.md` and `.ai-run/guides/integration/external-integrations.md` state Team Analytics is **enterprise-admin-only** and does not return billable token/cost fields
- [ ] Docs describe member flow: Cursor Usage → Export CSV → `--cursor-usage-csv <path>` (once 09 lands; can stub the flag name agreed in 09)
- [ ] Docs do not tell non-admin members to create/use `CURSOR_TEAM_ANALYTICS_API_KEY` for cost/tokens
- [ ] Honesty wording retained: UI never labels cost cells `Included` / “covered by subscription”
- [ ] Scratch notes (05/06) amended so they don’t read as “remove Team Analytics entirely”
