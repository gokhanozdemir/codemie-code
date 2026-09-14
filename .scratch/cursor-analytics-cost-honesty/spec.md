# Cursor analytics: cost honesty + usage signal follow-on

Status: ready-for-agent

## Problem Statement

When I run `codemie analytics --report --open --include-external` and look at Cursor sessions, cost cells say **Included** even though I care about API-equivalent spend estimated from tokens — subscription billing is irrelevant to me. When I deselect Claude (and other agents) in the top bar so only Cursor remains, Input/Output token KPIs collapse to empty dashes. That feels like Cursor data vanished, when what actually happened is: almost every Cursor session in the report has no local billable token signal, Claude was carrying the totals, and the report still labels unmeasurable cost as if it were covered by a plan.

I want honest empty states, real estimates when any tokens exist (including model=Auto), and a clear follow-on path for restoring recent Cursor usage signals without inventing zeros.

## Solution

1. **Cost honesty (local, ship now).** Stop using the word Included / “covered by subscription” anywhere in the analytics report. Unmeasurable sessions show an em dash. When a Cursor (or any) session has recoverable tokens, show an API-equivalent USD estimate even if the model is Auto/unknown/unpriced, using a documented Sonnet-equivalent fallback rate, and keep the existing partial-usage badge so I know the figure is a floor/estimate.
2. **Honest Cursor-only empty state.** When the filtered set has no measurable token totals, Overview and Cost KPIs stay dashes with copy that says local token telemetry is absent — not that spend was free or included.
3. **Follow-on for richer Cursor usage.** Open a separate effort for optional Enterprise Team Analytics integration and/or alternate token sources. Do **not** pretend the Team Analytics API already returns tokens or cost (it does not, per the external-integrations guide). Any remote integration stays opt-in, fail-soft, user-scoped, and visually separate from the local session table.

## User Stories

1. As an analytics report reader, I want cost cells never to say “Included”, so that I am not told subscription status instead of an estimate or unknown.
2. As an analytics report reader, I want unmeasurable sessions to show “—” for cost, so that I do not confuse absence of data with free usage.
3. As an analytics report reader, I want unmeasurable sessions to show “—” for tokens, so that structural zeros are not presented as “zero tokens used”.
4. As an analytics report reader, I want mixed groups (some measured, some not) to show the sum of measured costs/tokens, so that known data is not hidden by unknown peers.
5. As an analytics report reader, I want session-modal cost subtitles never to say “covered by subscription”, so that wording matches API-equivalent intent.
6. As an analytics report reader, I want a partial-usage badge when Cursor bubble tokens are sparse, so that I know the estimate understates real usage.
7. As an analytics report reader, I want Input/Output KPIs to remain visible when at least one session in view has measured or partial tokens, so that sparse Cursor signal is not wiped by aggregate helpers.
8. As an analytics report reader, I want Cursor-only views with no token signal to explain that local telemetry is missing, so that deselection of Claude does not look like a filter bug.
9. As an analytics report reader, I want tool-call success/failure for Cursor to keep working independently of tokens, so that #11’s tool path is not regressed by cost-honesty work.
10. As an analytics report reader, I want Claude/Codex/Copilot totals unchanged when Cursor has no tokens, so that honesty fixes do not invent Cursor spend into other agents.
11. As an analytics report reader, I want agent chips to keep filtering by agent name only, so that “unselect Claude” continues to mean the Claude agent, not “any Claude-named model”.
12. As an analytics report reader, I want Cursor sessions whose tracking model is a priced id (e.g. grok-4.6) to be estimated with that model’s rates when tokens exist, so that estimates prefer real attribution.
13. As an analytics report reader, I want Cursor sessions whose model is Auto/default/unknown to still get a USD estimate when tokens exist, so that lack of a concrete model does not force a blank or Included cost.
14. As an analytics report reader, I want that Auto/unknown estimate to use a documented Claude Sonnet API-equivalent rate table entry, so that the stand-in is stable and reviewable.
15. As an analytics report reader, I want Auto/unknown estimates always marked usagePartial, so that I never treat the stand-in as an invoice.
16. As an analytics report reader, I want the original model label (Auto, unknown, etc.) preserved on the session/per-model row, so that the estimate does not silently rename the model to Sonnet.
17. As an analytics report reader, I want pricedSessions / coverage semantics to remain “had recoverable usage”, so that a partial Cursor floor still counts as priced rather than “no token reader”.
18. As an analytics report reader, I want unpriced-model listing to still mention Auto when the original model was Auto, so that coverage diagnostics stay truthful even if a fallback rate was applied.
19. As a CodeMie operator, I want `--include-external` behavior unchanged, so that Cursor remains opt-in and never appears without the flag.
20. As a CodeMie operator, I want analytics without `--include-external` to omit Cursor entirely, so that external sessions stay gated.
21. As a CodeMie operator, I want regenerating a report after these fixes to drop every “Included” string from the HTML client bundle for cost formatting, so that old copy cannot linger.
22. As a CodeMie developer, I want cost enrichment to keep using adapter-supplied `tokensByModel` as the Cursor usage path, so that we do not add a fake per-message usage walk for bubbles.
23. As a CodeMie developer, I want bubble reads to stay fail-soft and read-only, so that Cursor schema drift cannot crash analytics.
24. As a CodeMie developer, I want ADR 0001 respected (no invented concrete model for `default` beyond the display label Auto), so that Auto remains Auto in the UI while cost uses an explicit estimate policy.
25. As a CodeMie developer, I want Overview Est. cost to show “—” when nothing in view is measurable, so that a Cursor-only empty set does not show $0.00.
26. As a CodeMie developer, I want Overview token KPIs to use measured-set semantics rather than raw `tTotal > 0` alone when mixed with unknown sessions, so that provenance stays consistent with Cost tab helpers.
27. As a product owner, I want a follow-on ticket for Cursor Enterprise Team Analytics API integration scoped to what the API actually returns today, so that we do not promise token fields it does not have.
28. As a product owner, I want that follow-on to require both a configured credential and an explicit CLI opt-in flag before any network call, so that local-only analytics stays the default promise.
29. As a product owner, I want Team Analytics data (if integrated) rendered in a separate labelled report section, so that local sessions and team-API aggregates are never silently merged or double-counted.
30. As a product owner, I want Team Analytics pulls filtered to the requesting user’s own email (by-user), so that colleagues’ activity never appears in my personal CodeMie report.
31. As a product owner, I want a research spike in the follow-on for alternate billable-token sources (usage export, future API fields, other local stores), so that the recent-token gap is pursued without pretending bubbles still work for current Cursor builds.
32. As a product owner, I want documentation updated to say recent Cursor builds often write zero `tokenCount` on bubbles while tools still appear, so that operators understand the local floor.
33. As a QA reader, I want a fixture-driven Cursor session with bubble tokens + Auto model to render a non-zero estimate and partial badge, so that the Auto fallback is verifiable without live DB dependence.
34. As a QA reader, I want a fixture-driven Cursor session with no token signal to render “—” for cost and tokens (never Included), so that the empty path is verifiable.
35. As a QA reader, I want a fixture-driven Cursor session with priced non-Auto model + tokens to use that model’s rates, so that fallback does not override real prices.
36. As an analytics report reader, I want cache-read / context-bloat series to keep excluding sessions with no cache concept when only partial input/output exist, so that Cursor does not plot misleading zero-height bloat bars.
37. As an analytics report reader, I want Cost-by-agent charts to omit or dash agents whose sessions are all unmeasurable, so that a Cursor wedge does not appear as $0 “Included”.
38. As a CodeMie developer, I want no change to discovery unions of `composerHeaders` + transcripts for this honesty work, so that session counts stay stable while copy and pricing policy change.
39. As a CodeMie developer, I want no widening of max-age solely to harvest year-old token bubbles as a substitute for recent telemetry, so that we do not paper over the real gap.
40. As a stakeholder, I want the follow-on clearly labelled out-of-band from the honesty ship, so that agents can implement A without blocking on Enterprise research.

## Implementation Decisions

### Workstream A — Cost honesty (this ship)

- Keep Cursor as an analytics-only agent: discover from local stores, tag `native-external`, gate with `--include-external`. Do not install or launch Cursor.
- Keep the existing usage provenance model on parsed sessions: `usageUnavailableReason` when no token signal; `usagePartial` + `tokensByModel` when sparse bubble tokens exist. Do not synthesize Claude-shaped per-message `usage` walks for bubbles.
- Keep cost enrichment’s adapter fallback: when the per-message usage map is empty, adopt `usageMeta.tokensByModel`. Do not add a dedicated Cursor branch to the per-message usage reader dispatcher unless a later change needs per-turn series (bubbles have no reliable per-turn chronology for series).
- **Estimate policy when tokens exist but `lookupPrice(model)` misses:** apply the published Claude Sonnet API-equivalent rate entry already used elsewhere in the pricing table (`claude-sonnet-4` family rates). Preserve the session’s displayed model name (Auto / unknown / original). Mark `usagePartial`. Prefer a real priced tracking-db model whenever lookup succeeds.
- **Report client:** remove the Included unpriced label. Unmeasurable → em dash for USD and tokens. Replace “covered by subscription” modal copy with language about missing local token signal or API-equivalent estimate. Keep the partial-usage note.
- **Overview / Cost empty state:** when the filtered session set has no measured usage, show dashes and a short subtitle that local token telemetry is absent for sessions in view (Cursor-heavy case). Do not change agent-chip filtering semantics.
- Respect ADR 0001: fail-soft, read-only, scoped bubble queries, `default` displayed as Auto, no invented invoice-grade certainty.
- Do not invent token counts for sessions whose bubbles only carry `{inputTokens:0,outputTokens:0}` or no `tokenCount`.

### Workstream B — Follow-on (separate ticket after A)

- Cursor Enterprise Team Analytics API remains **not integrated**. Guide fact to preserve: documented endpoints do **not** return token or cost fields; the API cannot alone close the billable-token gap.
- If/when integrated: require credential **and** explicit invocation opt-in; user-scoped `by-user` only; render as a **separate labelled section**; never silently merge into the local session table (unsolved reconciliation: no composerId join key on aggregates).
- Parallel research spike: identify whether any other local or exportable Cursor artifact now carries billable input/output for recent sessions; document negative evidence if none. Do not expand discovery age solely to resurface year-old bubble tokens as “the fix”.
- Update operator docs (`CURSOR_INTEGRATION` / external-integrations) to state that recent Cursor builds often omit nonzero bubble `tokenCount` while `toolFormerData` still works.

### Confirmed test seams

1. **Primary:** session cost record after enrichment — feed Cursor-shaped usage provenance through the enricher; assert tokens, estimate USD, partial flag, and absence of subscription semantics.
2. **Secondary:** report client formatting helpers / Overview empty-state contracts — unmeasurable → `—`; measured/partial → numeric; never `Included`.
3. **Follow-on only:** deep module behind a small interface for optional Team Analytics fetch → normalized user-scoped rows for a separate report section (not joined into local sessions).

## Testing Decisions

- Good tests assert external behaviour at the seams above (cost record fields; formatting outputs), not SQLite internals or DOM/Chart wiring.
- Prefer existing Vitest patterns around the cost enricher and native Cursor loader fixtures; extend those rather than inventing a third harness.
- Fixture cases for Workstream A:
  - tokens + Auto → nonzero estimate, `usagePartial`, model label still Auto
  - tokens + priced model → that model’s rates, no unnecessary fallback
  - no token signal → `usageUnavailableReason`, cost/tokens format as unknown (dash), never Included
  - regression: non-Cursor agents’ priced totals unchanged for the same fixtures
- Workstream B: no implementation tests in A; when B starts, test the opt-in gate (no network without flag+credential) and that team-API data cannot appear inside the local session table payload.
- Tests only when the implementing agent is explicitly asked to write/run them (repo policy), but the seams above are the intended attachment points.

## Out of Scope

- Changing agent-chip filters into model filters, or adding model chips (unless a later ticket asks).
- Inventing billable tokens from `contextTokensUsed`, transcript text length, or tool-call counts.
- Merging Team Analytics aggregates into per-session Cursor rows.
- Team-wide / leaderboard data in personal analytics.
- Silent network calls based solely on a configured API token.
- Issue #12 documentation-only Enterprise API write-up as a substitute for this honesty ship (may be folded into Workstream B docs).
- Widening default discovery max-age to harvest legacy bubble tokens.
- Renaming `readCursorBubbles` to a Map-style bubble index, or adding bubble memoization, unless a measured perf need appears.
- Adding a `gatherUsageDeduped('cursor')` branch solely for symmetry with the enricher fallback.

## Further Notes

- Live verification on one operator machine (2026-09-05 report): 469 Cursor sessions, 0 with tokens, 0 with `usagePartial`, 469 with `usageUnavailableReason`, 24 with tool calls. Nonzero bubble `tokenCount` composers existed only ~354–408 days ago and were absent from `composerHeaders`. This is why Cursor-only KPI collapse is data-faithful, not a chip bug.
- Original plan `we-the-issues-10-11-transient-crab` Steps 1–3 are largely shipped (bubbles + usageMeta + enricher fallback). Step 4 / Included copy / Auto estimate policy remain the actionable local gap.
- Domain vocabulary: analytics-only agent, `native-external`, `--include-external`, `composerHeaders`, `cursorDiskKV` bubbles, `usagePartial`, `usageUnavailableReason`, `tokensByModel`, API-equivalent estimate, ADR 0001 fail-soft.
- Tracker: this spec lives at `.scratch/cursor-analytics-cost-honesty/spec.md` with triage status `ready-for-agent`. Split implementation issues with `/to-tickets` if desired (A vs B).
