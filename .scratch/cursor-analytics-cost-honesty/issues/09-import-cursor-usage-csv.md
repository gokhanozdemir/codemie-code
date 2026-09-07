# 09: Import Cursor usage-events CSV for tokens and cost (members)

**What to build:** Give **team members** (and anyone without an admin Team Analytics key) a way to pass a locally downloaded Cursor Usage CSV into analytics report generation. CodeMie reads token and `Cost` columns, filters to the report owner’s email when the `User` column is present, and surfaces API-equivalent spend even when every row’s `Kind` is `Included`. Prefer a separate labelled “Cursor usage export” section and/or day–model aggregates clearly marked as export-sourced — do not invent `composerId` joins. No network call in this ticket. Enterprise admins keep Team Analytics (06/07) for non-token aggregates; this ticket is the member billable-usage path.

**Blocked by:** None (can start immediately). Complements 07/08 (admin Team Analytics kept; members use this path).

**Status:** ready-for-agent

- [ ] Explicit CLI flag accepts a filesystem path to a usage-events CSV (e.g. `--cursor-usage-csv <path>`)
- [ ] Parser accepts the observed header set: Date, User, Kind, Model, Input (w/ and w/o Cache Write), Cache Read, Output Tokens, Total Tokens, Cost (tolerate added columns)
- [ ] Rows with `Kind=Included` still contribute tokens and `Cost` (never mapped to “no cost” / Included UI label)
- [ ] When `User` is present, only the report owner’s email rows are kept
- [ ] Export data appears as an opt-in, clearly labelled source (not silently merged into Claude totals)
- [ ] Missing/unreadable file fails soft: report continues; export section omitted with a clear reason
- [ ] Verifiable against a fixture derived from the sample export shape (61 events, models like `auto` / `cursor-grok-*`, nonzero Cost)

Prototype note (sample export 2026-09-05): all 61 rows were `Kind=Included` yet `Cost` summed to ~$25.25 with large token totals — product must use `Cost`/tokens, not `Kind`.
