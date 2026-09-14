# 05: Research spike — alternate recent Cursor billable-token sources

**What to build:** A written go/no-go on whether any other local or exportable Cursor artifact carries recent billable input/output tokens. Negative evidence is an acceptable outcome. No new production reader ships in this ticket; findings feed ticket 06 and any later token-source work.

**Blocked by:** 04 — Docs — recent Cursor bubble tokens are sparse/absent

**Status:** done — local NO-GO, but SUPERSEDED by #21 (dashboard usage CSV has the tokens; see amendment at the end)

- [x] Spike notes which stores/exports were checked and what each carries (or lacks) for recent sessions
- [x] Explicit conclusion: viable source found vs none found for recent billable I/O
- [x] Confirms Team Analytics still lacks token/cost fields (or documents a change if upstream added them)
- [x] Does not widen default discovery max-age solely to harvest year-old bubble tokens as “the fix”
- [x] Does not invent tokens from context-window fill, transcript length, or tool-call counts
- [x] Findings appended under this ticket (or linked artifact) so 06 can proceed without rediscovery

---

## Findings (spike run 2026-09-05)

**Conclusion: NO-GO. No local or exportable Cursor artifact carries recent billable input/output
tokens.** Nothing new ships from this ticket; the local floor documented in 04 stands.

Method: read-only inspection of one operator machine's live Cursor installation (databases copied
to a scratch dir before querying, so no lock was taken on Cursor's own files).

### Stores checked

| Store | Recent billable tokens? | What it actually carries |
|---|---|---|
| `state.vscdb` → `cursorDiskKV` `bubbleId:*` | **No** | 5,134 of 5,177 bubbles carry a `tokenCount` object, but 5,080 are `{inputTokens:0, outputTokens:0}`. `toolFormerData` works throughout. |
| `state.vscdb` → `composerHeaders` | **No** | Discovery only (501 rows, 0–72 days old). No usage fields. |
| `state.vscdb` → `cursorDiskKV` `composerData:*` | **No** | `contextTokensUsed`, `contextTokenLimit`, `totalUsedTokens`, `promptTokenBreakdown`, `estimatedTokens` — **context-window fill, not billing**. Explicitly out of scope. |
| `state.vscdb` → `cursorDiskKV` `agentKv:*` | **No** | An opaque blob cache of *other* tools' cached payloads and file contents (Copilot extension telemetry, MCP tool results, and a mock usage-export document with placeholder values like `developer@company.com`). Not a Cursor usage ledger, and it holds third-party secrets — reading it would be actively wrong. |
| `state.vscdb` → `cursorDiskKV` `messageRequestContext:*` | **No** | Prompt-assembly context (git status, project layouts, attached files). |
| `state.vscdb` → `ItemTable` | **No** | Only billing-*banner dismissal* flags (`cursor.billingBanner.*`, `cursor.dismissedCreditGrantIds`) and auth tokens. No usage figures. |
| `~/.cursor/ai-tracking/ai-code-tracking.db` | **No** | `ai_code_hashes`, `scored_commits`, `conversation_summaries`, `tracked_file_content`. Line-attribution and model labels only; zero token columns. |
| `conversation-search.db` (globalStorage) | **No** | FTS index over conversation titles/text. The only `token` match is the FTS `tokenize=` pragma — a text tokenizer, not billing. |
| `~/.cursor/chats/*/*/store.db` (31 stores) | **No** | `blobs` + `meta`. 2,887 blobs decoded and 31 meta rows decoded: zero token-shaped fields. `meta` carries `agentId`, `name`, `mode`, `createdAt`, `lastUsedModel`. |
| `~/.cursor/projects/*/agent-transcripts/*.jsonl` | **No** | Only `token_budget` / `tokens` strings originating from MCP *tool payloads*, not Cursor usage. |
| Team Analytics API | **No** | Re-verified against the live docs (below). |

### The decisive cross-check

Nonzero `tokenCount` bubbles exist but belong to a disjoint, aged-out population:

- 31 composers hold all 54 nonzero-token bubbles; their ages are **354–408 days**.
- **0 of those 31 appear in `composerHeaders`**, so they are undiscoverable by design.
- Of the 3,671 bubbles under the 501 *discoverable* composers, **every single `tokenCount` is zero**.

So the token signal has not moved to another store — it stopped being written. No reader change can
recover it, and widening `--max-age` would only resurface year-old conversations to manufacture a
total that says nothing about recent work (explicitly rejected).

### Team Analytics API re-verification

Fetched <https://cursor.com/docs/account/teams/analytics-api> on 2026-09-05. Documented response
fields are diff/acceptance and activity counters — `total_suggested_diffs`, `total_accepted_diffs`,
`total_rejected_diffs`, `total_green_lines_accepted`, `total_red_lines_accepted`, `total_suggestions`,
`total_accepts`, `total_rejects`, `messages`, `command_name`, `skill_name`, `model`. **No token or
cost fields at any tier** — unchanged from the guide's existing claim. Auth is an API key
(`-u YOUR_API_KEY:`); by-user filtering via a `users` parameter of email addresses is supported,
which is what makes ticket 06's user-scoped constraint achievable.

### What this means for ticket 06

06 may proceed, but strictly as **non-token aggregates in a separate labelled section**. This spike
found no token source, so 06 must not be presented as closing the cost gap.

### Amendment (2026-09-05 evening) — dashboard usage CSV is GO (members)

Reopened after operator-provided export
`team-usage-events-17821605-2026-09-05.csv` and live probe of
`GET cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens`:

- CSV carries Date, User, Kind, Model, input/cache/output tokens, Total Tokens, **Cost**.
- Sample: 61 rows, all `Kind=Included`, yet Cost summed ≈ **$25.25** with large token totals —
  `Included` is a billing category, not “no cost”.
- Admin `crsr_` key → **401** on this endpoint (member-usable via session cookie / UI download).
- Session cookie `WorkosCursorSessionToken=<userId>::<accessToken>` → **200** CSV.

**Audience split (product decision):**

- **Enterprise team admins** — keep opt-in Team Analytics API (ticket 06) for non-token aggregates; clarify admin-only in 07/08.
- **Team members** — usage-events CSV file import (09) and optional cookie fetch (10) for tokens + Cost.

Do **not** roll back Team Analytics entirely; do not tell members to use the admin API for billable usage.

---

## Amendment (2026-09-05, after issue #21)

**The NO-GO conclusion above is superseded.** This spike searched only *local* stores and its
local findings stand — no local artifact carries recent billable tokens. But it never checked
Cursor's **dashboard usage export**, which does.

Verified against a real export (`team-usage-events-*.csv`, 2026-09-05): 61 events, all
`Kind=Included`, carrying **39,952,466 tokens and $25.25 of cost**. A second export from the same
day held 380 events and 201,523,437 tokens.

`Included` is Cursor's billing category — "covered by your plan" — not a claim that the usage was
free or unmeasured. Reading it as "no cost" is exactly the mistake that made this data look
worthless.

The export is now imported via `--cursor-usage-csv` (issue #21, commit 2fb0c9e). The "Do not widen
discovery max-age" and "do not invent tokens from context fill / transcript length / tool counts"
conclusions are unaffected and still binding.
