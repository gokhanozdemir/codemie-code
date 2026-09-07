/**
 * The Cursor usage export, converted into the analytics pipeline's own shapes.
 *
 * Cursor's local stores no longer carry billable token counts, so the dashboard's
 * Usage → Export CSV is the only accurate record of what a Cursor session actually cost
 * (see `cursor.usage-csv.ts` and `docs/CURSOR_INTEGRATION.md`). Rendering that file as its own
 * isolated panel — which is what the first cut did — left every headline number in the report
 * ignoring 39.9M real tokens and $25.25 of real cost.
 *
 * This module follows the OTEL precedent (`otel-loader.ts`), the existing answer to "a flat
 * per-event file that has to behave like sessions": synthesize {@link RawSessionData} plus a
 * canonical {@link SessionCostIndex}, hand both to the pipeline, and let the aggregator, the
 * formatter, the exporter and the report client treat the result like any other session. No
 * consumer needs a special case, so no consumer can forget one.
 *
 * Two rules keep the conversion honest:
 *
 *   - **Conserved.** Every event lands in exactly one place. An event whose timestamp falls
 *     inside exactly one Cursor session's activity window is attributed to that session; anything
 *     else — no window, or several overlapping ones — goes to a per-day pseudo-session rather
 *     than to a guess. That refusal matches `81dbeb1`, which already declines to guess when a
 *     Cursor slug is ambiguous. Sum the output and you get the file's own totals, once.
 *   - **Attributed.** Every line this module produces carries `costBasis: 'vendor-billed'`.
 *     These are Cursor's own billed figures, not CodeMie's estimate from a pricing table, and
 *     that distinction has to survive the merge — it is the whole point of the honesty work.
 *
 * Overwriting a matched session's usage loses nothing: a local Cursor session carries $0 and
 * zero tokens today, with a `usageUnavailableReason` explaining why.
 */

import type { RawSessionData, SessionStartEvent, SessionEndEvent } from './data-loader.js';
import type { MetricDelta } from '@/agents/core/metrics/types.js';
import type { SessionCost, SessionCostIndex, CostSummary, TokenUsage, ModelCost } from './cost/types.js';
import { emptyUsage, addUsage } from './cost/cost-calculator.js';
import type { CursorUsageEvent, CursorUsageImport } from '@/agents/plugins/cursor/cursor.usage-csv.js';
import { normalizeModelName } from '@/utils/model-normalizer.js';

/** The agent every synthesized session is attributed to — Cursor's rows are Cursor's. */
const AGENT_NAME = 'cursor';

/** Prefix for a per-day pseudo-session id; `cursor-usage:<YYYY-MM-DD>`. */
const PSEUDO_ID_PREFIX = 'cursor-usage:';

export interface CursorUsageSessions {
  /** Pseudo-sessions for unmatched events. Matched events need no new session. */
  rawSessions: RawSessionData[];
  /** Cost rows for both matched real sessions and the pseudo-sessions. */
  costIndex: SessionCostIndex;
  summary: CostSummary;
  /** Events attributed to a real Cursor session. */
  matched: number;
  /** Events that fell into a per-day pseudo-session instead. */
  unmatched: number;
}

/** The window a session covers, from the events the native loader synthesized it with. */
interface SessionWindow {
  sessionId: string;
  start: number;
  end: number;
}

/** The model an event is attributed to, normalized and with one fallback for a blank cell. */
function modelOf(event: CursorUsageEvent): string {
  return normalizeModelName(event.model || '(unknown)');
}

/** Append to a map of grouped events, creating the group on first sight. */
function pushInto(groups: Map<string, CursorUsageEvent[]>, key: string, event: CursorUsageEvent): void {
  const group = groups.get(key);
  if (group) {
    group.push(event);
  } else {
    groups.set(key, [event]);
  }
}

/** Convert the export's token columns into the pipeline's normalized usage shape. */
function toUsage(event: CursorUsageEvent): TokenUsage {
  const { input, output, cacheRead, cacheCreation, total } = event.tokens;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    // The export does not distinguish the 1h-TTL subset of cache creation, and inventing a split
    // would misstate a figure Cursor never published.
    cacheCreation1h: 0,
    total,
  };
}

/**
 * The activity windows usable for matching.
 *
 * Only Cursor's own sessions are considered — no other agent's window can contain a Cursor usage
 * event, and including them would only manufacture false ambiguity. A zero-width window is kept:
 * an event stamped at that exact instant is still unambiguously that session's. A session with no
 * usable start is not — there is nothing to compare against.
 */
function windowsOf(sessions: RawSessionData[]): SessionWindow[] {
  const windows: SessionWindow[] = [];
  for (const session of sessions) {
    if (session.startEvent?.agentName !== AGENT_NAME) {
      continue;
    }
    const start = session.startEvent?.data.startTime;
    if (start === undefined || !Number.isFinite(start) || start <= 0) {
      continue;
    }
    const end = session.endEvent?.data.endTime;
    windows.push({
      sessionId: session.sessionId,
      start,
      end: end !== undefined && Number.isFinite(end) && end > start ? end : start,
    });
  }
  return windows;
}

/**
 * The one session whose window contains this timestamp, or undefined.
 *
 * Several containing windows means the data cannot say which session spent the tokens. Picking
 * the narrowest — the tactic `otel-loader.ts` uses for parallel subagents — is defensible there
 * because those windows describe nested work; Cursor conversations run side by side, so the
 * tightest window carries no such meaning and the choice would be a coin toss printed as fact.
 */
function containingSession(windows: SessionWindow[], ms: number): string | undefined {
  let found: string | undefined;
  for (const w of windows) {
    if (ms < w.start || ms > w.end) {
      continue;
    }
    if (found !== undefined) {
      return undefined; // ambiguous — refuse to guess
    }
    found = w.sessionId;
  }
  return found;
}

/** Roll a group of events up into one canonical cost row. */
function toSessionCost(sessionId: string, events: CursorUsageEvent[]): SessionCost {
  const perModelMap = new Map<string, TokenUsage>();
  const perModelCost = new Map<string, number>();
  let tokens = emptyUsage();
  let costUSD = 0;

  for (const event of events) {
    const usage = toUsage(event);
    tokens = addUsage(tokens, usage);
    costUSD += event.costUSD;
    // Normalized so a Cursor spelling collapses onto the same key every other source uses; the
    // name is otherwise left alone, with provenance carried by `costBasis` rather than a suffix
    // that would split one model across two rows in every by-model chart.
    const model = modelOf(event);
    perModelMap.set(model, addUsage(perModelMap.get(model) ?? emptyUsage(), usage));
    perModelCost.set(model, (perModelCost.get(model) ?? 0) + event.costUSD);
  }

  const perModel: ModelCost[] = [...perModelMap.entries()]
    .map(([model, modelTokens]): ModelCost => ({
      model,
      tokens: modelTokens,
      costUSD: perModelCost.get(model) ?? 0,
      unpriced: false,
      costBasis: 'vendor-billed',
    }))
    .sort((a, b) => b.costUSD - a.costUSD || b.tokens.total - a.tokens.total);

  return {
    sessionId,
    tokens,
    costUSD,
    perModel,
    // Priced, but from Cursor's invoice rather than a native log — so `hadLog` stays false and
    // no `agentSessionFile` is claimed for a file that does not exist.
    priced: true,
    hadLog: false,
  };
}

/** One ordinary-looking Cursor session standing in for a day's unmatched events. */
function pseudoSession(day: string, events: CursorUsageEvent[]): RawSessionData {
  const sessionId = `${PSEUDO_ID_PREFIX}${day}`;
  const stamps = events.map((e) => Date.parse(e.date)).filter((n) => Number.isFinite(n));
  const startTime = stamps.length ? Math.min(...stamps) : 0;
  const endTime = stamps.length ? Math.max(...stamps) : 0;
  const models = [...new Set(events.map(modelOf))];

  const delta: MetricDelta = {
    recordId: `${sessionId}-usage`,
    sessionId,
    agentSessionId: sessionId,
    timestamp: startTime,
    tools: {},
    models,
    // Drives the session title, so the row reads as what it is rather than as a bare id.
    userPrompts: [{ count: 1, text: `Cursor usage — ${day}` }],
    syncStatus: 'synced',
    syncAttempts: 0,
  };

  const startEvent: SessionStartEvent = {
    recordId: sessionId,
    type: 'session_start',
    timestamp: startTime,
    codeMieSessionId: sessionId,
    agentName: AGENT_NAME,
    syncStatus: 'synced',
    // The export carries no project, and attributing a day's spend to whichever repo happened to
    // be open would invent an association Cursor never recorded.
    data: { provider: 'native', workingDirectory: 'Unknown', startTime },
  };

  const endEvent: SessionEndEvent = {
    recordId: `${sessionId}-end`,
    type: 'session_end',
    timestamp: endTime,
    codeMieSessionId: sessionId,
    agentName: AGENT_NAME,
    syncStatus: 'synced',
    data: { endTime, duration: Math.max(0, endTime - startTime), totalTurns: 1 },
  };

  return { sessionId, startEvent, endEvent, deltas: [delta] };
}

/**
 * Convert a parsed usage export into sessions and cost rows the pipeline already understands.
 *
 * Pass the run's whole session set: the matcher narrows to Cursor's own sessions itself, so no
 * caller has to know which agent name the export belongs to.
 */
export function buildCursorUsageSessions(
  usage: CursorUsageImport,
  sessions: RawSessionData[]
): CursorUsageSessions {
  const windows = windowsOf(sessions);
  const byMatchedSession = new Map<string, CursorUsageEvent[]>();
  const byDay = new Map<string, CursorUsageEvent[]>();
  let matched = 0;
  let unmatched = 0;

  for (const event of usage.events) {
    const ms = Date.parse(event.date);
    const sessionId = Number.isFinite(ms) ? containingSession(windows, ms) : undefined;
    if (sessionId !== undefined) {
      pushInto(byMatchedSession, sessionId, event);
      matched += 1;
      continue;
    }
    pushInto(byDay, event.day || 'unknown', event);
    unmatched += 1;
  }

  const costIndex: SessionCostIndex = new Map();
  for (const [sessionId, events] of byMatchedSession) {
    costIndex.set(sessionId, toSessionCost(sessionId, events));
  }

  const rawSessions: RawSessionData[] = [];
  for (const [day, events] of byDay) {
    const session = pseudoSession(day, events);
    rawSessions.push(session);
    costIndex.set(session.sessionId, toSessionCost(session.sessionId, events));
  }

  const summary: CostSummary = {
    totalCostUSD: [...costIndex.values()].reduce((sum, c) => sum + c.costUSD, 0),
    pricedSessions: costIndex.size,
    totalSessions: costIndex.size,
    unpricedModels: [],
  };

  return { rawSessions, costIndex, summary, matched, unmatched };
}
