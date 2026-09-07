# Analytics Report

The `codemie analytics --report` command generates a **self-contained HTML dashboard** from your local AI session history. No server required — open the file in any browser and explore your data offline.

---

## Quick Start

```bash
# Generate report covering all tracked history and open it immediately
codemie analytics --report --open

# Last 7 days
codemie analytics --report --open --last 7d

# Specific date range
codemie analytics --report --open --from 2025-01-01 --to 2025-01-31

# Filter to one project
codemie analytics --report --open --project codemie-code

# Save to a specific path
codemie analytics --report --report-output ~/reports/weekly.html

# Also export the underlying data as JSON
codemie analytics --report --report-format both

# Include ALL local agent usage — also the sessions you ran outside CodeMie
codemie analytics --report --open --include-external

# Add your own Cursor Team Analytics aggregates (opt-in; makes a network call)
CURSOR_TEAM_ANALYTICS_API_KEY=... codemie analytics --report --open --cursor-team-analytics
```

> **If your question is "what did AI actually cost us?", you probably want `--include-external`.**
> By default the report counts only sessions CodeMie launched. Any time you ran `claude`,
> `codex`, `gemini`, `pi`, or `copilot` directly, that spend is discovered but withheld.
> See [Session provenance](#session-provenance) for why, and for the trade-off.

---

## What the Report Covers

The dashboard reads every AI session CodeMie has tracked — Claude Code, Codex, Gemini, OpenCode, Pi, GitHub Copilot CLI, and the built-in agent — plus native agent logs it discovers automatically on disk. It builds a single portable HTML file with **nine interactive views**, grouped in the sidebar as *Insights*, *Spend*, and *Raw*, plus an optional tenth ([Cursor Team API](#cursor-team-analytics)) that appears only when you opt into that remote pull.

Discovered sessions that CodeMie did not launch are **excluded by default**; see [Session provenance](#session-provenance).

---

## Views

### Overview

![Overview](assets/analytics-report-overview.png)

The landing view. Gives every headline number at a glance:

- **Sessions** — total count with wall-clock duration and turns per session
- **Files & lines** — file operations, lines added/removed, net change
- **Tool calls** — total calls and overall success rate
- **Estimated cost** — API-equivalent spend across priced sessions; `—` when nothing in view is measurable (see [When cost and tokens show `—`](#unknown-cost))

Below the headline KPIs, two supplementary sections appear:

**Token usage** breaks down input tokens, output tokens, cache writes (tokens written to the prompt cache), and cache reads (tokens served back from cache), plus a combined total. When no session in view has any token signal, these show `—` with a note explaining that local token telemetry is absent — see [Analytics-only agents](#analytics-only-agents).

**Efficiency summary** shows cache-read cost, bloat percentage (cache reads as a share of total spend), dead session count, and average context per call — all linking to the Efficiency tab for full detail.

Charts: net lines over time (line chart by day) and sessions by model (doughnut). A **Top projects** table rounds out the view with per-project file and line counts, each clickable to open a project drill-down modal.

---

### Agents · Compare

![Agents](assets/analytics-report-agents.png)

Side-by-side comparison across every AI agent that has sessions in the data. For each agent: session count and share of total activity, net lines, turns, tool success rate, and average session duration.

Charts: stacked sessions-per-day by agent, and a doughnut of net lines by agent. A summary table covers sessions, turns, files, net lines, top model, tool success rate, and cost per agent.

Toggle individual agents on or off with the agent pills in the top filter bar to isolate the agents you care about.

---

### Projects

Expandable table of every project. Click a row to reveal its branches; click the project name to open the project modal with a full session list. Columns: sessions, turns, files changed, lines added/removed, net lines, tool success rate, cost.

---

### Tools & Models

Per-tool usage breakdown: call count and success rate rendered as horizontal progress bars (green ≥ 90%, amber ≥ 70%, red below). Token volume by model shown as a horizontal bar chart.

Three additional invocation charts show the top **skills invoked**, **agent subtypes**, and **slash commands** used — ranked by call count across all sessions in view.

---

### Activity

![Activity](assets/analytics-report-activity.png)

Heat map of sessions by weekday × hour of day (local time). Instantly shows when people are actually working with AI. Supported by two bar charts: sessions by hour of day and sessions by weekday.

---

### Efficiency

![Efficiency](assets/analytics-report-efficiency-tab.png)

Focuses on context waste and productivity. Key metrics:

- **Average context / call** — how many cache tokens are re-read on each turn (a proxy for prompt bloat)
- **Bloat %** — cache-read cost as a fraction of total spend
- **Dead sessions** — sessions that consumed real cost but produced zero file changes and zero net lines (pure inference waste)
- **Session depth** — histogram of turns per session to surface sessions that were never compacted or restarted
- **Command effectiveness** — estimated cost per file changed, broken down by dominant slash command
- **Code changes summary** — files written vs. edited, lines added/removed/net

A ranked table of the most bloated sessions and the dead-session list are both clickable to open the session detail modal.

---

### Frameworks · Compare

Groups all sessions by **detected framework or tooling signal** (source classification). For each framework — CodeMie AI Factory, Superpowers, SpecKit, BMAD, OpenSpec, and Pure chat — shows a compact per-session summary plus adoption share.

**What it shows:**

- **Source comparison table** — one row per framework, columns: session count, adoption share (% of sessions in current view), per-session averages (turns, cost, net lines, files changed), and tool success rate. Rows sorted by session count descending.
- **Adoption doughnut chart** — visual share of sessions by source, sized by session count.

Both table and chart respect active date-range, agent, and project filters; adoption share is always relative to sessions in the filtered view (never the full dataset).

**How sources are detected:**

Framework classification is invocation-name-based, implemented in `session-source-detector.ts`. Detectors run in priority order (first match wins); fallback to "Pure chat" if none match. See the [source detector](src/cli/commands/analytics/report/session-source-detector.ts) for the full list and matching patterns.

**Limitation:**

Metrics shown are generic per-session metrics aggregated by source — **no framework-specific or heuristic KPIs** such as spec adherence, task-completion rate, or cycle-time analysis. Session data carries no structured per-framework events, so these deeper signals are not yet available. This view answers *"how is adoption distributed?"* and *"how do session patterns differ by source?"* but not *"how effective is each framework for achieving its methodology goals?"*

---

### Cost

![Cost](assets/analytics-report-cost.png)

Estimated API-equivalent spend (token usage × model pricing) — what the same usage would have been metered at through the API. It is a benchmark for comparing agents and tracking consumption trends, **not an invoice**, and it is never presented as one.

> **Why this reads lower than the terminal's live cost.** Cost here is counted **per API response**: each response's token usage is priced exactly once, matching how the provider bills and how Claude Code's own telemetry (`cost.usage`) records it. A single response is written to the native log across several lines (e.g. a `thinking` line and a `tool_use` line, each repeating the same usage), and the live statusline in the terminal sums those lines — so it over-counts multi-part responses and shows a higher number. For sessions heavy on extended thinking plus tool use, expect the report total to sit noticeably below the live statusline; the report figure is the authoritative, de-duplicated one.

Key elements:

- **Coverage banner** — tells you how many sessions were successfully priced and which agents have full, partial, or missing token data
- **Coverage by agent table** — per-agent breakdown of total sessions, priced sessions, sessions with a native log, and coverage status
- **Cost by agent** — doughnut chart
- **Cost by model** — horizontal bar chart of USD spend per model
- **Most expensive sessions** — top 10 ranked by cost, with per-session token breakdown (input, output, cached)

<a id="unknown-cost"></a>

#### When cost and tokens show `—`

A dash means **unmeasurable**, not free and not zero. It appears when a session left no readable
local token signal — the native log was rotated away, or the agent records transcripts but no token
telemetry at all (see [Analytics-only agents](#analytics-only-agents)).

The report will not paper over that gap:

- Unmeasurable sessions render `—` for cost and for every token field, never `$0.00` or `0`. A
  structural zero and a genuine zero look different because they mean different things.
- Aggregates dash out only when **nothing** in the group was measurable. A mixed group still shows
  the real sum of whatever was measured, so known data is never hidden by unknown peers.
- No cell is ever labelled `Included` or "covered by subscription". Your plan's billing status is
  not something the local logs record, and absence of a token count is not evidence of free usage.

#### Estimated costs and the partial badge

When a session has real recovered tokens but its model is not in the pricing table — Cursor's
`Auto`, or simply a model newer than the table — the cost is estimated at a published **Claude
Sonnet** API rate rather than dropped to `$0`. Such sessions:

- keep their own model label (`Auto` stays `Auto`; nothing is renamed to Sonnet),
- are marked **partial usage** in the session detail modal, and
- are still listed under "models with no published price" in the Cost coverage banner.

Treat any partial figure as an understated floor, not a measurement.

---

### Sessions

![Sessions](assets/analytics-report-sessions.png)

Full paginated table of every session (up to 300 shown; searchable). Columns: date, first prompt, agent, project, branch, source, turns, net lines, input/output/cached tokens, cost.

The **Source** column carries the framework classification described under [Frameworks · Compare](#frameworks--compare), so you can scan tooling adoption without leaving the raw table.

Click any row to open the **session detail modal**.

---

## Session Detail Modal

![Session Detail](assets/analytics-report-session-modal.png)

Clicking a session anywhere in the report opens a detail overlay with:

- **Cost & Time** — API-equivalent cost, cache-read cost, duration, start time
- **Token usage** — input, output, cache read, cache create, total
- **Activity** — turns, tool calls and success rate, agent/skill/command invocation counts
- **Code changes** — files changed, lines added/removed, net
- **Token & cost growth chart** — cumulative cost and token usage per turn (from the native log; shown when data is available)
- **Dispatch timeline** — Interactive Gantt of every top-level dispatch. A session bar spans the full activity window across the top, then each agent, skill, and slash-command dispatch is rendered as its own bar positioned by wall-clock start time, so each sits where it actually ran. The window is the union of the tracked session span and the dispatch span, so dispatches from a resumed or compacted session still place correctly. Short skills and zero-duration commands fall back to a minimum bar width so they stay visible as markers. Click any bar to open a detail panel on the right showing wall-clock duration, start offset from session start, top tool call counts, and — for agent and skill dispatches where usage can be attributed to their time window — estimated cost and token breakdown (input / output / cache read / cache write). Slash-command dispatches are point events with no window to attribute usage from, so they show timing only, never a cost.
- **Skills / Agent subtypes / Slash commands** — chip lists of what was invoked and how many times
- **Copy buttons** — copy the session ID or the transcript's file location to the clipboard, for pasting into a bug report or opening the raw log directly

---

## Filters

All filtering happens client-side — no server, instant response.

| Filter | Where | How |
|---|---|---|
| Time range | Top bar | Preset buttons: Today, 7d, 30d, 90d, All; or enter custom From/To dates |
| Agent | Top bar | Toggle agent pills on/off |
| Project | Top bar | Dropdown of all projects in the data |

Filters apply to every view simultaneously. The URL does not update, so share the HTML file directly — recipients can apply their own filters.

---

## Output Formats

| Format | Flag | Output |
|---|---|---|
| HTML dashboard | `--report` or `--report-format html` | Self-contained `.html` with all charts and data embedded |
| JSON data | `--report-format json` | The cost-enriched session payload — useful for further analysis in notebooks or BI tools |
| Both | `--report-format both` | Writes the `.html` and the `.report.json` side by side with a shared base name |

Default output paths, in the current directory:

- HTML — `./codemie-analytics-<email-slug>-YYYY-MM-DD.html`
- JSON — `./codemie-analytics-<email-slug>-YYYY-MM-DD.report.json`

The JSON report deliberately ends in `.report.json` rather than `.json` so it can never collide with the very different file `--export json` writes. Override either with `--report-output <path>`.

**Report metadata and your email.** Reports embed the reporting user's email plus the period covered. The address is read from your CodeMie config; if it is missing and you're on an interactive terminal, report generation warns and prompts for it once, then saves it for future runs. Declining the prompt cancels report generation. The `<email-slug>` segment is dropped from the filenames when no email is available.

---

## Automatic Per-Session Report on Exit

When an interactive agent session exits — `codemie-claude`, `codemie-codex`, `codemie-opencode`, `codemie-pi`, or `codemie-copilot` — CodeMie automatically writes a JSON analytics report for that session to `./docs/codemie/analytics/codemie-analytics-<session_id>.json`.

- **Enabled by default** — it runs in-process as part of session finalization, not as a separate command.
- **Disable per run** with `--no-analytics-report`, e.g. `codemie claude --no-analytics-report ...` (the flag is available on every agent that supports the feature).
- **Non-fatal** — a failure never blocks session exit, and the report is skipped when the session produced no analytics data.

---

## Data Sources

CodeMie merges two sources to give the most complete picture:

1. **Tracked sessions** — metrics written by the CodeMie hooks during sessions CodeMie launched
2. **Native agent logs** — transcripts left on disk by `claude`, `codex`, `gemini`, `pi`, and `copilot`, discovered automatically and deduped against tracked sessions
3. **Analytics-only agents** — agents CodeMie never launches and only reads. `cursor` is the one today: its conversations are read from Cursor's own local stores and surfaced like any other external session. See [Cursor Integration](CURSOR_INTEGRATION.md) and [Analytics-only agents](#analytics-only-agents) below.

Pass `--no-scan-native` to disable native-log discovery and use only CodeMie-tracked sessions.

Discovery looks back as far as your date filter requires: with `--from` or `--last` the window is that range, and with no lower bound it is effectively unlimited.

Cost enrichment requires the native log to read per-turn token data. Sessions where the log has already been rotated or deleted will appear with `—` cost; the **Coverage** section in the Cost view shows exactly which sessions are priced.

<a id="analytics-only-agents"></a>

### Analytics-only agents (Cursor) — expect no token counts

Cursor is read, never launched. Its transcripts, tool outcomes, projects, and models all come
through, but **recent Cursor builds record no billable token counts** — they write zero, or omit the
field entirely, while tool-call data keeps working. This is Cursor's behaviour, not a CodeMie bug.

What that looks like in the report:

- Cursor sessions appear (with `--include-external`) with real turns, tool calls, and file activity.
- Their cost and token cells are `—`, per [When cost and tokens show `—`](#unknown-cost).
- **If you deselect every other agent in the top bar, the Overview and Cost KPIs go all-dashes and
  show a short note saying local token telemetry is absent for the sessions in view.** That is the
  filter working correctly on absent data — not a broken agent chip. Tool-call tables keep working.

A measurement taken on one machine: of 469 discovered Cursor sessions, 0 carried any token signal
and 24 carried tool calls. Conversations that *do* still hold token counts were all roughly a year
old and no longer discoverable at all. There is no local store that has the recent numbers — every
Cursor database, per-session chat store, and transcript directory was checked. CodeMie will not
manufacture the figure from context-window fill, transcript length, or tool-call counts, because
those are not billable tokens and presenting them as such would trade an honest blank for a
confident wrong number.

<a id="session-provenance"></a>

### Session provenance — and why some sessions are hidden

Finding a native log is not the same as counting it. Every discovered session is tagged with a **provenance**, recorded on the session's start event as `provider`:

| Provenance | Meaning | In the report by default? |
|---|---|---|
| `native` | CodeMie launched this session (`codemie-claude`, `codemie-codex`, …). Its transcript carries a `codemie_session_start` ownership marker. | ✅ Yes |
| `native-external` | The same agent, run **directly** — `claude`, `codex`, `gemini`, `pi`, `copilot` — with no CodeMie involvement, so no ownership marker. | ❌ **No** — opt in with `--include-external` |
| `native-unmanaged` | Reserved for agents CodeMie can only ever read analytics for and never launches. No agent currently carries this tag. | ✅ Yes |

The default exists so that a report titled "CodeMie usage" measures CodeMie usage: without the ownership gate, every unmanaged run of an agent CodeMie *can* manage would be silently folded into CodeMie's numbers.

That default is the right one for adoption reporting and the **wrong** one for consumption reporting. If you want total local AI spend across every agent on the machine, ask for it:

```bash
codemie analytics --report --open --include-external
```

**This is the flag that shows all of your local agent usage.** GitHub Copilot CLI sessions are included in the gate, so they too are absent from the default report. Cursor sessions are too — CodeMie never launches Cursor, so *every* Cursor session is external; see [Cursor Integration](CURSOR_INTEGRATION.md).

Two things to know before you rely on the wider number:

- **It is broader but less precise.** An external session has no CodeMie run to attribute it to — no profile, no managed provider — and its cost depends entirely on a native log that may already have been rotated away. Expect a lower priced-session ratio in the Cost view's **Coverage** banner than you'd see for CodeMie-launched sessions.
- **`--include-external` needs native scanning.** External sessions *are* discovered natives, so `--no-scan-native --include-external` adds nothing — the first flag suppresses the very sessions the second one asks for.

`--include-external` applies to the default local-session source only. The `analytics otel` subcommand does not accept it — an OTEL events file has no notion of CodeMie ownership.

<a id="cursor-team-analytics"></a>

### Cursor Team Analytics (optional, opt-in, network)

Everything above reads local files. This one feature does not: it pulls your own aggregates from
**Cursor's Enterprise Team Analytics API**. It is off unless you explicitly ask for it.

```bash
export CURSOR_TEAM_ANALYTICS_API_KEY='<your Cursor Team API key>'
codemie analytics --report --open --cursor-team-analytics
```

**Both the flag and the key are required.** A key sitting in your environment never triggers a call
on its own, and neither does the flag without a key. Reading the machine you are on is a promise
CodeMie already makes; calling a remote service is not, so it stays a deliberate act each time.

**What you get.** Four `by-user` endpoints — agent edits, tab completions, models, and commands —
filtered to your own email address, rendered in their own **Cursor Team API** view in the sidebar.
The view is hidden entirely unless a pull succeeded.

**What you do not get: tokens or cost.** None of Cursor's documented endpoints returns a token or
cost field at any tier, so this cannot close the gap described in
[Analytics-only agents](#analytics-only-agents), and it is never presented as if it did. The rows
are edit and activity counters only.

**It is shown separately on purpose.** The API returns per-user/per-date aggregates with no session
identifier, so there is no key on which to join them to your local Cursor sessions — and no token or
cost field to join with. Merging them into the session table would mean inventing both. Nothing in
this section contributes to any cost or token figure elsewhere in the report.

**Scope and privacy.** Only `by-user` endpoints are queried, always filtered to the requesting
user's own email. No team-wide endpoint and no leaderboard, so a colleague's activity can never
appear in your personal report. The email comes from your CodeMie config — the same one embedded in
report metadata.

**Requirements and failure modes.** You need an admin-scoped Cursor **Team** API key from an
enterprise team; individual and personal plans cannot use this API at all. Every failure — missing
key, rejected key, HTTP error, DNS failure, or a schema change on Cursor's side — degrades to an
omitted or explicitly-partial section and prints a one-line notice. The local report, which is the
part that always works, is never taken down by a remote outage. Run with `CODEMIE_DEBUG=true` to see
the per-endpoint outcome.

---

### OTEL events file (`analytics otel`)

As an alternative to the local-session sources above, the `analytics otel` subcommand builds the same report from a **flattened OTEL events file** (`otel-events.jsonl`) — for example, telemetry exported from a fleet or CI environment rather than the current machine's history.

```bash
# Report from an OTEL events file
codemie analytics otel --file ./otel-events.jsonl --report --open

# Scope to a single user (matches native user.email or user.id)
codemie analytics otel --file ./otel-events.jsonl --user jane@example.com --report
```

With this source, **cost is authoritative**: it is read directly from each event's native `cost_usd`, so no native-log enrichment is needed and every session with token data is priced. All the same filter and report flags apply (`--from`/`--to`, `--project`, `--agent`, `--branch`, `--session`, `--report-format`, etc.); the time window and `--user` are applied to the raw events, and the remaining structural filters narrow the session set so a filtered report is never mislabeled.

---

## CLI Reference

```
codemie analytics [options]

Report flags:
  --report                  Generate a self-contained HTML dashboard
  --open                    Open the report in the default browser after generation
  --report-output <path>    Output path (default: ./codemie-analytics-YYYY-MM-DD.html)
  --report-format <fmt>     html | json | both (default: html)

Filter flags:
  --last <duration>         Last N days/hours/minutes: 7d, 24h, 30m
  --from <YYYY-MM-DD>       Start date (inclusive)
  --to   <YYYY-MM-DD>       End date (inclusive)
  --project <pattern>       Filter by project name (basename, partial, or full path)
  --agent <name>            Filter by agent: claude, gemini, codex, etc.
  --branch <name>           Filter by git branch
  --session <id>            Filter to a single session

Source flags:
  --no-scan-native          Skip native-log discovery (CodeMie-tracked sessions only)
  --include-external        Also count local sessions CodeMie did not launch
                            (see "Session provenance"; requires native scanning)
  --cursor-team-analytics   Fetch your own Cursor Team Analytics aggregates.
                            Makes a NETWORK CALL; also requires
                            CURSOR_TEAM_ANALYTICS_API_KEY. Neither the flag nor
                            the key does anything on its own.
                            (see "Cursor Team Analytics")

Other flags:
  -v, --verbose             Session-level breakdown in the terminal output
  --export <fmt>            Export terminal data to json or csv file
  -o, --output <path>       Output path for --export
```

**Environment variables**

| Variable | Effect |
|---|---|
| `CURSOR_TEAM_ANALYTICS_API_KEY` | Admin-scoped Cursor Team API key. Required *together with* `--cursor-team-analytics`; see [Cursor Team Analytics](#cursor-team-analytics). |
| `CODEMIE_DEBUG=true` | Verbose per-source discovery and enrichment logging, including each Team Analytics endpoint's outcome. |

**Every filter and source flag governs the terminal output and the HTML report alike.** There is no report-only or terminal-only filtering: `--include-external`, `--no-scan-native`, and the date/project/agent filters all decide which sessions the command sees, and both outputs are rendered from that same set.

The date filters control which sessions are **embedded** in the report; the client-side range presets (Today / 7d / 30d / 90d) then let the report viewer narrow further within that data.

### OTEL source subcommand

```
codemie analytics otel --file <path> [options]

  --file <path>             Path to the flattened OTEL events file (required)
  --user <id>               Scope to one user (native user.email or user.id)
```

All filter, report, and export flags from the base command also apply to `analytics otel`. The source flags do not: an OTEL events file is neither scanned for native logs nor gated on CodeMie ownership, so `--no-scan-native` and `--include-external` have no meaning here. Cost is read from each event's native `cost_usd`.
