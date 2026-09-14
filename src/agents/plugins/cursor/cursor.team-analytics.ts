/**
 * Cursor Enterprise Team Analytics — optional, opt-in, user-scoped.
 *
 * This is the ONLY place CodeMie analytics talks to a network service. Everything else in the
 * analytics path reads local files, and that difference is the point: reading the machine you
 * are on is a promise CodeMie already makes, calling a remote service is not. So the call is
 * gated on BOTH an explicit invocation flag and a configured credential — a token sitting in
 * config must never be enough on its own.
 *
 * Two things about the audience, because getting them wrong strands people:
 *
 * 1. **This is enterprise-team-ADMIN only.** The endpoints require an admin-scoped key that an
 *    ordinary team member cannot obtain. Telling a member to "set CURSOR_TEAM_ANALYTICS_API_KEY"
 *    sends them after a credential they cannot get.
 * 2. **It returns no tokens and no cost at any tier** (re-verified against the live docs
 *    2026-09-05), so even an admin cannot close the Cursor billable-usage gap with it. The rows
 *    below are edit/activity aggregates only.
 *
 * The path that *does* yield real Cursor tokens and cost — for admins and members alike — is the
 * dashboard usage export, imported via `--cursor-usage-csv` (see `cursor.usage-csv.ts`).
 *
 * These rows are also per-user/per-date aggregates carrying no `composerId`, so there is no key
 * on which to join them to local sessions — hence the report renders them as a clearly separate
 * section rather than folding them into the session table.
 *
 * See `.ai-run/guides/integration/external-integrations.md` and `docs/CURSOR_INTEGRATION.md`.
 */

import { logger } from '@/utils/logger.js';

/** Documented API root. */
const API_BASE = 'https://api.cursor.com';

/**
 * The by-user endpoints worth surfacing. Deliberately excludes every `team/*` endpoint and the
 * leaderboard: CodeMie analytics reports the operator's own usage, and pulling colleagues'
 * activity into a personal report is out of scope regardless of what the credential can read.
 */
export const TEAM_ANALYTICS_ENDPOINTS = [
  { endpoint: 'agent-edits', label: 'Agent edits' },
  { endpoint: 'tabs', label: 'Tab completions' },
  { endpoint: 'models', label: 'Models used' },
  { endpoint: 'commands', label: 'Commands' },
] as const;

/** Who can actually use this. Surfaced in CLI help and the report's empty state. */
export const TEAM_ANALYTICS_AUDIENCE =
  'Enterprise team admins only — requires an admin-scoped Cursor Team API key.';

/**
 * What to tell everyone else. Deliberately does NOT name the API key env var: a member who
 * cannot get a key must be pointed at the path that works, not at the one that will reject them.
 */
export const TEAM_ANALYTICS_MEMBER_HINT =
  'For real Cursor tokens and cost, export your usage from the Cursor dashboard (Usage → Export) and pass it with --cursor-usage-csv <path>.';

export interface TeamAnalyticsRequest {
  /** Explicit per-invocation opt-in (the CLI flag). A credential alone must never enable calls. */
  enabled: boolean;
  /** Admin-scoped API key. Absent on personal plans, which simply get no section. */
  apiKey?: string;
  /** The requesting user's own email — the `by-user` filter, and the reason this stays personal. */
  userEmail?: string;
  startDate?: string;
  endDate?: string;
}

/** One endpoint's rows, passed through as the API returned them. */
export interface TeamAnalyticsMetric {
  endpoint: string;
  label: string;
  rows: Record<string, unknown>[];
}

export interface CursorTeamAnalytics {
  userEmail: string;
  startDate?: string;
  endDate?: string;
  metrics: TeamAnalyticsMetric[];
  /** Endpoints that failed; surfaced so a partial section is never mistaken for a complete one. */
  failedEndpoints: string[];
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface TeamAnalyticsDeps {
  fetch: FetchLike;
}

/** `curl -u KEY:` — the key as the basic-auth username with an empty password. */
function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

function endpointUrl(endpoint: string, req: TeamAnalyticsRequest): string {
  const url = new URL(`/analytics/by-user/${endpoint}`, API_BASE);
  url.searchParams.set('users', req.userEmail as string);
  if (req.startDate) {
    url.searchParams.set('startDate', req.startDate);
  }
  if (req.endDate) {
    url.searchParams.set('endDate', req.endDate);
  }
  return url.toString();
}

/** Accepts either a bare array or the documented `{ data: [...] }` envelope. */
function rowsOf(payload: unknown): Record<string, unknown>[] {
  const body = payload as { data?: unknown } | unknown[];
  const data = Array.isArray(body) ? body : body?.data;
  return Array.isArray(data) ? (data.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]) : [];
}

/**
 * Fetch the requesting user's own Team Analytics aggregates, or `null` when the gate is closed
 * or nothing could be retrieved. Never throws: a failed pull degrades to an omitted section so
 * the local report — the part that always works — is never taken down by a remote outage.
 */
export async function fetchCursorTeamAnalytics(
  req: TeamAnalyticsRequest,
  deps: TeamAnalyticsDeps = { fetch: globalThis.fetch as unknown as FetchLike }
): Promise<CursorTeamAnalytics | null> {
  if (!req.enabled || !req.apiKey || !req.userEmail) {
    // Not an error: this is the default state for everyone without an enterprise key.
    logger.debug('[cursor] team analytics skipped (needs both the opt-in flag and an API key)');
    return null;
  }

  const metrics: TeamAnalyticsMetric[] = [];
  const failedEndpoints: string[] = [];

  for (const { endpoint, label } of TEAM_ANALYTICS_ENDPOINTS) {
    try {
      const res = await deps.fetch(endpointUrl(endpoint, req), {
        headers: { Authorization: authHeader(req.apiKey), Accept: 'application/json' },
      });
      if (!res.ok) {
        logger.debug(`[cursor] team analytics ${endpoint} returned HTTP ${res.status}`);
        failedEndpoints.push(endpoint);
        continue;
      }
      metrics.push({ endpoint, label, rows: rowsOf(await res.json()) });
    } catch (error) {
      // Schema drift, DNS failure, auth rejection — all the same to the report: omit and move on.
      logger.debug(`[cursor] team analytics ${endpoint} unusable: ${(error as Error).message}`);
      failedEndpoints.push(endpoint);
    }
  }

  if (metrics.length === 0) {
    return null;
  }
  return { userEmail: req.userEmail, startDate: req.startDate, endDate: req.endDate, metrics, failedEndpoints };
}
