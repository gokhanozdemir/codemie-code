# 10: Optional cookie fetch of usage-events CSV (after file import)

**What to build:** After file import works, optionally fetch the same CSV CodeMie already parses by using the signed-in Cursor session cookie from the local app store (`WorkosCursorSessionToken=<userId>::<accessToken>`), behind an explicit flag. Never use an admin `crsr_` Team API key for this endpoint. Fail soft; default remains local-only or file-based.

**Blocked by:** 09 — Import Cursor usage-events CSV for tokens and cost

**Status:** ready-for-agent

- [ ] No fetch runs unless an explicit opt-in flag is set (credential/cookie on disk alone is not enough)
- [ ] Auth uses session cookie shape proven against the dashboard export endpoint — not Bearer `crsr_` / Admin API
- [ ] Fetched body is fed through the same CSV parser as 09 (one code path)
- [ ] Date range / team id come from documented operator inputs or safe defaults aligned to the report window
- [ ] 401/403/schema drift → omit export section; local report still succeeds
- [ ] Docs warn this is an undocumented dashboard endpoint and file import remains the supported fallback
- [ ] Secrets are never logged

Probe note (2026-09-05): `crsr_` → 401; `WorkosCursorSessionToken` with `userId::jwt` → 200 CSV starting with `Date,User,...`.
