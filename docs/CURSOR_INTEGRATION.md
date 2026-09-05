# Cursor Integration

How CodeMie reads Cursor usage into `codemie analytics`, what it can and cannot know, and what
to do when the numbers look wrong.

## Overview

Cursor is CodeMie's first **analytics-only** agent (`analyticsOnly: true` in
`src/agents/plugins/cursor/cursor.plugin.ts`). CodeMie never installs, configures, updates or
launches Cursor, and Cursor is absent from every management surface — `codemie install`,
`codemie update`, `codemie doctor`, first-run setup. There is no npm package, no CLI command and
no provider mapping. The plugin exists solely to hand the agent registry a session adapter that
reads what Cursor has already written to disk.

Because CodeMie never launches Cursor, no Cursor session carries a CodeMie ownership marker, so
every Cursor session is tagged `native-external` and is **hidden until you pass
`--include-external`** — the same gate that applies to any agent run outside CodeMie (see
[Session provenance](ANALYTICS-REPORT.md#session-provenance)):

```bash
codemie analytics --report --open --include-external
```

All reads are strictly read-only and fail-soft. CodeMie never writes to, migrates or locks a
store Cursor owns, and no Cursor problem — missing data, corrupt database, schema change — can
fail an analytics run for the other agents.

## Data locations and structure

Cursor writes to two unrelated trees — `~/.cursor` and the editor's own app-data directory — and CodeMie reads four sources across them. `CURSOR_HOME` overrides both (see
[Environment configuration](#environment-configuration)).

| Source | Path | Supplies |
|---|---|---|
| **`composerHeaders`** (primary discovery) | `state.vscdb` → `composerHeaders` table | one row per agent conversation, keyed `composerId`: project path (`workspaceIdentifier.uri.fsPath`), branch (`activeBranch.branchName` / `createdOnBranch`), created/updated timestamps, `totalLinesAdded` / `totalLinesRemoved` / `filesChangedCount` |
| **Agent transcripts** (secondary) | `~/.cursor/projects/<project-slug>/agent-transcripts/<composerId>/<composerId>.jsonl` | role-tagged prompt/response text, `tool_use` blocks, `turn_ended` markers, a human-readable `<timestamp>` on each prompt |
| **AI-tracking database** (enrichment) | `~/.cursor/ai-tracking/ai-code-tracking.db` → `ai_code_hashes` (`conversationId`, `fileName`, `model`, `timestamp`, `source`) | model, edited file paths, first/last edit time, joined on `conversationId`; only `source = 'composer'` rows are the agent's work — `human` rows are the user's own edits |
| **`cursorDiskKV`** (enrichment) | `state.vscdb` → `cursorDiskKV`, keys `bubbleId:<composerId>:<bubbleId>` | per-tool success/failure counts (`toolFormerData.status` / `.name`) and a sparse `tokenCount` |

`state.vscdb` is the VS Code-derived *application* state store, so it lives under the OS
app-data directory rather than `~/.cursor`:

| Platform | `state.vscdb` |
|---|---|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` (falling back to `~/AppData/Roaming/Cursor/...` when `%APPDATA%` is unset) |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

Everything joins on one identifier: **`composerId`**, which is also the transcript's directory
and file name and `ai_code_hashes.conversationId`. Discovery unions the header ids with the
transcript ids, so a conversation with a header but no transcript (the common case) and a
transcript with no header (rare — schema drift, a pruned header row) both produce a session row.
Headers marked `isDraft: true` are conversations that were never started and are excluded.

Full rationale for reading an undocumented store, and the constraints that come with it, is in
[ADR 0001](adr/0001-cursor-session-discovery-from-state-vscdb.md).

### What Cursor sessions can and cannot report

- **Activity window** prefers the header's own timestamps, then the tracking database's first/last
  edit, then the transcript's prompt stamps, and only then the transcript file's birthtime/mtime.
  File times are last because a conversation resumed days later would otherwise report a span of
  days instead of minutes.
- **Messages carry no per-message timestamps** on purpose, so the loader falls back to the
  session window rather than a fabricated per-message clock.
- **Model** comes from the tracking database. Cursor writes the literal `default` when the user
  delegated model choice; that is reported as **`Auto`** — Cursor's own word for it — never as
  whatever model Cursor happens to default to.
- **Tokens and cost** come from `cursorDiskKV`'s sparse per-bubble `tokenCount` (present on
  roughly 1% of bubbles). When a session has no token signal at all, `usageUnavailableReason` is
  set and the report renders tokens and cost as **unmeasurable**, not as a confident zero.

### Database schema and versioning

`state.vscdb` and `ai-code-tracking.db` are Cursor-internal and undocumented; there is no schema
version to read and no compatibility promise. CodeMie therefore pins nothing and asserts nothing:
each query names the tables and columns it needs, and anything else — a renamed table, a dropped
column, a changed row shape — degrades to "that source contributed nothing" for this run.
`composerHeaders` rows in particular are handled in both observed shapes (flat columns, and the
VS Code-typical `key TEXT, value TEXT` pair with a JSON blob in `value`, whose key may itself carry
a `<prefix>:<composerId>` form). `cursorDiskKV` values are JSON blobs holding `toolFormerData`
(`name`, `status` — one of `completed` / `error` / `cancelled` / `loading`) and an optional
`tokenCount` (`inputTokens`, `outputTokens`).

There is no version marker in either database, so CodeMie cannot detect which Cursor release wrote
a schema and does not try. If you need to correlate drift with a release, the Cursor version is in
Cursor's own About dialog; pair it with the `[cursor] ... unusable` debug line naming the table or
column that moved (see [Database schema drift](#database-schema-drift-after-a-cursor-update)).

## Environment configuration

| Variable | Effect |
|---|---|
| `CURSOR_HOME` | Overrides `~/.cursor`. Also relocates `state.vscdb` to `$CURSOR_HOME/User/globalStorage/state.vscdb`, mirroring its real layout relative to Cursor's app-data root. Unset (the default) uses `~/.cursor` plus the per-OS app-data path above. |
| `CODEMIE_DEBUG=true` | Enables the `[cursor]` debug logging described under [Logging and debugging](#logging-and-debugging). |

`CURSOR_HOME` mirrors `COPILOT_HOME` in the Copilot CLI plugin and is what lets the whole
ingestion path be driven against a fixture tree in tests.

### When Cursor is not installed

No Cursor home, an empty Cursor home, no `state.vscdb` and no tracking database all yield **zero
Cursor sessions and no error**. Analytics for every other agent is unaffected. Nothing about the
report changes except that Cursor does not appear in it.

## Troubleshooting

### Empty analytics results while you are actively using Cursor

1. **You did not pass `--include-external`.** This is the overwhelmingly common cause. Cursor
   sessions are hidden by default because CodeMie did not launch them. Re-run with
   `codemie analytics --report --open --include-external`.
2. **Native scanning is off.** `--no-scan-native` turns off native-log discovery for *every* agent,
   including the discovery `--include-external` asks for, so the two flags together add nothing.
3. **Your date filter excludes them.** Discovery looks back only as far as `--from` / `--last`
   requires.
4. **A non-default Cursor location.** If Cursor stores data elsewhere, point `CURSOR_HOME` at it.
5. **`state.vscdb` is not where CodeMie looks.** Confirm the per-OS path above exists; run with
   `CODEMIE_DEBUG=true` and look for the `[cursor]` lines naming the paths that were tried.

### Missing or corrupt Cursor data

Each source degrades independently, so a session is built from whatever remains:

| Missing / broken | Result |
|---|---|
| Transcript file | Header-only row: project, branch, timing, line counts, model — but no prompt/response text |
| `composerHeaders` row | Transcript-only row: project path guessed by walking the directory slug, branch and line counts absent |
| `ai-code-tracking.db` | No model and no edited-file list; timing falls back to header or prompt stamps |
| `cursorDiskKV` rows | No tool outcomes; usage reported as unmeasurable |
| Corrupt / locked / unreadable database | Treated exactly like "absent" — that source contributes nothing |
| Unparseable transcript line | That line is dropped; the rest of the session is kept (a live session's last line is often truncated mid-write) |

### Node runtime too old for `node:sqlite`

`node:sqlite` landed in **Node 22.5**; this repo supports Node >= 20. On Node 20 or 22.0–22.4 the
import fails, both SQLite sources are skipped, and Cursor degrades to transcript-only rows. This
is deliberate — the module is imported dynamically so an older runtime cannot take the analytics
run down at module load. Upgrade to Node >= 22.5 for full Cursor enrichment.

### Database schema drift after a Cursor update

Symptom: Cursor sessions still appear, but model, tool outcomes, line counts or timing suddenly
go missing. Run with `CODEMIE_DEBUG=true` and look for `[cursor] ... unusable` lines — the
underlying SQLite error names the table or column that moved. This is a fail-soft degradation,
not a bug in your setup; the fix is a plugin update, not a workaround on your machine.

### Permission issues with the Cursor home

Symptom: nothing under `~/.cursor` or the app-data directory is readable. CodeMie logs the read
failure at debug level and reports zero Cursor sessions. Confirm with `ls -l ~/.cursor` and
`ls -l` on the `state.vscdb` directory for your platform; the files must be readable by the user
running `codemie`. CodeMie needs no write access anywhere in Cursor's trees.

### Logging and debugging

Every read of a Cursor data source logs at debug level, and nothing there
ever escalates past debug: a missing, corrupt or drifted Cursor store is a degradation, not a
failure, so there are no warnings to look for. The one exception is CodeMie's own side of the
pipeline — a session processor that throws is logged at error level as
`[cursor-adapter] Processor <name> failed:`, because that is a CodeMie bug rather than a Cursor
condition.

```bash
export CODEMIE_DEBUG=true
codemie analytics --report --include-external
```

Three prefixes are in use, so filter on `[cursor` rather than `[cursor]`: `[cursor]` for the data-source
reads, `[cursor-discovery]` for session discovery, `[cursor-adapter]` for the adapter itself.

Expected messages include: `no ai-tracking database at <path>`, `node:sqlite unavailable — skipping
tracking enrichment`, `ai-tracking database unusable at <path>` (with the SQLite error), and
`tracking index covers N conversation(s)`.

## Developer guidance

Source lives in `src/agents/plugins/cursor/`: `cursor.paths.ts` (locations and the `CURSOR_HOME`
override), `cursor.state-db.ts` (`composerHeaders` discovery), `cursor.bubbles.ts` (`cursorDiskKV`
per-turn enrichment), `cursor.tracking-db.ts` (AI-tracking enrichment), `cursor.transcript.ts`
(JSONL reader), `cursor.session.ts` (the adapter that joins them).

### Creating test fixtures

Tests drive the whole path from the top seam — `loadNativeSessions()` — against a temporary
Cursor home reached through `CURSOR_HOME`, never by reaching into a parser. See
`src/cli/commands/analytics/__tests__/native-loader-cursor.test.ts` for the working pattern:

1. `mkdtempSync()` a directory and set `process.env.CURSOR_HOME` to it, so the run touches
   neither `~/.codemie` nor the developer's own `~/.cursor`.
2. Write transcripts at
   `<home>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, where the slug is the project path
   with leading separators dropped and `/` and `_` both replaced by `-`.
3. Write fixture SQLite databases at `<home>/ai-tracking/ai-code-tracking.db` and
   `<home>/User/globalStorage/state.vscdb`.
4. Re-import the module graph per test (`vi.resetModules()`), because the adapter memoizes its
   tracking index once per run and the memo would otherwise leak one fixture into the next.
5. Guard database-backed tests with `describe.skipIf(!hasNodeSqlite())` — Node < 22.5 cannot
   create them, which is the same degradation the product promises.

### Database connection safety

- Open with `new sqlite.DatabaseSync(path, { readOnly: true })`, `SELECT` only, and `close()` in a
  `finally` (itself wrapped, since closing a database that failed to open throws).
- Import `node:sqlite` **dynamically**; a static import breaks Node 20 at module load.
- Check `existsSync()` before opening, and treat every failure — missing table, renamed column,
  corrupt file, locked database — as "no data", returning the empty result.
- Parameterize any id in a query; never interpolate. `cursorDiskKV` must be filtered in SQL rather
  than scanned, as the table can reach ~1.4 GB.

### Schema evolution guidelines

When Cursor changes a schema, add tolerance rather than assertions. Guard every field
(`asString`, `asEpochMs` style helpers), accept both known row shapes where a table has them,
skip a malformed row instead of aborting the loop, and let a whole missing source degrade to an
empty index. Never report a value Cursor did not record: prefer an explicit "unmeasurable"
(`usageUnavailableReason`) or Cursor's own label (`Auto`) over a plausible-looking zero or
default. Any new source needs a fixture-driven test at the `loadNativeSessions()` seam plus a
degradation test proving analytics still works when that source is gone.

## See also

- [ADR 0001 — Cursor session discovery from `state.vscdb`](adr/0001-cursor-session-discovery-from-state-vscdb.md)
- [Analytics Report](ANALYTICS-REPORT.md) — provenance, `--include-external`, the report views
- [`.ai-run/guides/integration/external-integrations.md`](../.ai-run/guides/integration/external-integrations.md) — including the deferred Cursor Enterprise Team Analytics API
