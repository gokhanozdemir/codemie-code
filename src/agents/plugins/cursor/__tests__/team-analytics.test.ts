/**
 * Cursor Team Analytics gate + normalization tests.
 *
 * The safety property under test is negative: no network call may happen without BOTH an
 * explicit opt-in and a configured credential. `fetch` is injected and counts its calls, so
 * a regression that phones home shows up as a call count, not as a mocked-away detail.
 */

import { describe, it, expect } from 'vitest';
import { fetchCursorTeamAnalytics, TEAM_ANALYTICS_ENDPOINTS, type TeamAnalyticsRequest } from '../cursor.team-analytics.js';

/** A fetch stand-in that records every URL it was asked for. */
function recordingFetch(handler?: (url: string) => { status?: number; body?: unknown }) {
  const calls: string[] = [];
  const impl = async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push(String(url));
    const r = handler?.(String(url)) ?? {};
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
      headers: init?.headers,
    } as never;
  };
  return { impl, calls };
}

const enabled: TeamAnalyticsRequest = {
  enabled: true,
  apiKey: 'key_abc',
  userEmail: 'me@example.com',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
};

describe('Cursor Team Analytics opt-in gate', () => {
  it('makes no network call when the opt-in flag is absent, even with a credential', async () => {
    const f = recordingFetch();
    const out = await fetchCursorTeamAnalytics({ ...enabled, enabled: false }, { fetch: f.impl });
    expect(f.calls).toEqual([]);
    expect(out).toBeNull();
  });

  it('makes no network call when opted in but no credential is configured', async () => {
    const f = recordingFetch();
    const out = await fetchCursorTeamAnalytics({ ...enabled, apiKey: undefined }, { fetch: f.impl });
    expect(f.calls).toEqual([]);
    expect(out).toBeNull();
  });

  it('makes no network call when the requesting user has no known email to scope to', async () => {
    const f = recordingFetch();
    const out = await fetchCursorTeamAnalytics({ ...enabled, userEmail: undefined }, { fetch: f.impl });
    expect(f.calls).toEqual([]);
    expect(out).toBeNull();
  });
});

describe('Cursor Team Analytics request shape', () => {
  it('queries only by-user endpoints, scoped to the requesting user alone', async () => {
    const f = recordingFetch();
    await fetchCursorTeamAnalytics(enabled, { fetch: f.impl });
    expect(f.calls.length).toBe(TEAM_ANALYTICS_ENDPOINTS.length);
    for (const url of f.calls) {
      expect(url).toContain('/analytics/by-user/');
      expect(url).not.toContain('/analytics/team/');
      expect(url).not.toContain('leaderboard');
      expect(new URL(url).searchParams.get('users')).toBe('me@example.com');
      expect(new URL(url).searchParams.get('startDate')).toBe('2026-08-01');
    }
  });
});

describe('Cursor Team Analytics results', () => {
  it('returns the rows each endpoint actually provided, with no token or cost fields synthesized', async () => {
    const f = recordingFetch(() => ({ body: { data: [{ email: 'me@example.com', total_accepted_diffs: 12 }] } }));
    const out = (await fetchCursorTeamAnalytics(enabled, { fetch: f.impl }))!;
    expect(out.userEmail).toBe('me@example.com');
    expect(out.metrics.length).toBe(TEAM_ANALYTICS_ENDPOINTS.length);
    expect(out.metrics[0].rows[0]).toMatchObject({ total_accepted_diffs: 12 });
    // The API returns no token/cost fields; we must not manufacture any.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/costUSD|inputTokens|outputTokens|tokens"/);
  });

  it('degrades to a partial section when an endpoint fails, without throwing', async () => {
    const f = recordingFetch((url) => (url.includes('models') ? { status: 500 } : { body: { data: [{ n: 1 }] } }));
    const out = (await fetchCursorTeamAnalytics(enabled, { fetch: f.impl }))!;
    expect(out.failedEndpoints).toContain('models');
    expect(out.metrics.some((m) => m.endpoint === 'models')).toBe(false);
    expect(out.metrics.length).toBe(TEAM_ANALYTICS_ENDPOINTS.length - 1);
  });

  it('returns null rather than throwing when every endpoint fails', async () => {
    const f = recordingFetch(() => ({ status: 401 }));
    expect(await fetchCursorTeamAnalytics(enabled, { fetch: f.impl })).toBeNull();
  });

  it('survives a transport-level throw', async () => {
    const impl = async () => { throw new Error('ENOTFOUND api.cursor.com'); };
    expect(await fetchCursorTeamAnalytics(enabled, { fetch: impl as never })).toBeNull();
  });
});
