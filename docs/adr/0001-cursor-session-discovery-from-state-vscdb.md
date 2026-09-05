# ADR 0001 — Cursor session discovery reads `state.vscdb`

- Status: Accepted
- Date: 2026-09-04
- Applies to: `src/agents/plugins/cursor/`

## Context

Cursor is an analytics-only agent: CodeMie never installs, configures or launches it, and only
reads what Cursor has already written to disk (see the `cursor` row in [AGENTS.md](../../AGENTS.md)
and [docs/CURSOR_INTEGRATION.md](../CURSOR_INTEGRATION.md)).

Cursor exposes no local API and no supported export for agent conversations. Three local stores
carry parts of the picture, all keyed by the same `composerId`:

| Store | Location | Carries |
|---|---|---|
| Agent transcripts | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | role-tagged text, `tool_use` blocks, turn markers, a human-readable prompt stamp |
| AI-tracking database | `~/.cursor/ai-tracking/ai-code-tracking.db` | model, edited file paths, edit timestamps |
| Application state store | `state.vscdb` under Cursor's per-OS app-data directory | `composerHeaders` (one row per conversation), `cursorDiskKV` (one row per turn/bubble) |

Transcripts alone were tried first and proved insufficient: they exist for only a small fraction
of real conversations, carry no timestamps, no model and no token counts, and give no reliable
project path (only a slug that has to be walked back to a directory). A transcript-only report
therefore under-counts Cursor usage badly and mis-attributes the sessions it does find.

`state.vscdb` is VS Code's (and hence Cursor's) internal, undocumented state store. It is not a
public API, its schema can change in any Cursor release, and it is large — up to ~1.4 GB of
mostly unrelated editor state.

## Decision

`composerHeaders` in `state.vscdb` is the **primary** discovery source for Cursor sessions;
transcripts are secondary and joined by the shared `composerId`. Discovery unions the two id
sets, so a header without a transcript and a transcript without a header both produce a row.
`cursorDiskKV` supplies per-turn tool outcomes and the sparse token signal that gates partial
pricing. The AI-tracking database supplies model and edited files.

Constraints accepted with that decision:

- **Read-only.** Every database is opened with `readOnly: true` and only ever `SELECT`ed.
  CodeMie must never write to, migrate, or lock a store Cursor owns.
- **Fail-soft by mandate.** A missing file, a missing `node:sqlite` (Node < 22.5), a renamed
  table or column, a corrupt or locked database, or a malformed row degrades to fewer facts —
  never to a thrown error. A Cursor release must never be able to break `codemie analytics`.
- **Scoped queries.** `cursorDiskKV` is filtered by `composerId` in SQL (parameterized, never
  interpolated) rather than scanned, because of its size.
- **No invented facts.** `default` — Cursor's sentinel for delegated model choice — is reported
  as `Auto`, the term Cursor's own usage export uses, never as a concrete model name. Sessions
  with no token signal report usage as unmeasurable rather than as zero.
- **Draft rows excluded.** `isDraft: true` headers are conversations that were never started.

## Consequences

- Cursor coverage is dramatically better than transcript-only discovery, and project path,
  branch and line counts come from Cursor's own totals instead of being reconstructed.
- CodeMie depends on an undocumented schema. The fail-soft mandate is what makes that
  acceptable: the failure mode of schema drift is a thinner report, not a broken command.
- `CURSOR_HOME` relocates all three stores (with `state.vscdb` under `User/globalStorage`),
  which is what lets the whole path be tested against a fixture tree.

## Future work

### Cursor Enterprise Team Analytics API

Cursor publishes an official [Team Analytics API](https://cursor.com/docs/account/teams/analytics-api).
CodeMie does **not** integrate it. It is recorded as a known, deferred capability — with the
constraints already agreed for whenever it is built — in
[`.ai-run/guides/integration/external-integrations.md`](../../.ai-run/guides/integration/external-integrations.md#cursor-enterprise-team-analytics-api-not-integrated).
