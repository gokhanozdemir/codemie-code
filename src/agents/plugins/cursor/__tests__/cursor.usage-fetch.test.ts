/**
 * Cookie-authenticated usage-export fetch.
 *
 * Two properties matter more than the happy path and are asserted first: no request may leave
 * the machine without an explicit opt-in AND a configured URL, and the session token must never
 * reach a log line. The token used here is a fabricated string with the right *shape* only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fetchCursorUsageExport,
  readCursorSessionCookie,
  type UsageFetchRequest,
} from '../cursor.usage-fetch.js';

/**
 * Shape-accurate, entirely fabricated: `<userId>::<jwt>`.
 *
 * Assembled at runtime rather than written as a literal — a literal three-part JWT trips the
 * repo's gitleaks scan, and a secrets scanner that has learned to ignore this file is worse than
 * no scanner. The parts are meaningless: header `{"alg":"none"}`, body `{"sub":"test"}`.
 */
const FAKE_USER_ID = 'user_01ABCDEF';
const FAKE_JWT = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from('{"sub":"test"}').toString('base64url'),
  'notarealsignature',
].join('.');
const FAKE_COOKIE = `${FAKE_USER_ID}::${FAKE_JWT}`;

const csv = readFileSync(
  fileURLToPath(new URL('./fixtures/cursor-usage-events.csv', import.meta.url)),
  'utf-8'
);

function recordingFetch(handler?: (url: string, init?: unknown) => { status?: number; body?: string }) {
  const calls: { url: string; init?: { headers?: Record<string, string> } }[] = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, init });
    const r = handler?.(url, init) ?? {};
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => r.body ?? csv,
    };
  };
  return { impl, calls };
}

const base: UsageFetchRequest = {
  enabled: true,
  exportUrl: 'https://cursor.example/api/usage-export',
  cookie: FAKE_COOKIE,
  startDate: '2026-08-29',
  endDate: '2026-09-05',
};

describe('usage-export fetch gate', () => {
  it('makes no request without the explicit opt-in flag', async () => {
    const f = recordingFetch();
    expect(await fetchCursorUsageExport({ ...base, enabled: false }, { fetch: f.impl })).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('makes no request when no export URL is configured', async () => {
    const f = recordingFetch();
    expect(await fetchCursorUsageExport({ ...base, exportUrl: undefined }, { fetch: f.impl })).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('makes no request when no session cookie could be read', async () => {
    const f = recordingFetch();
    expect(await fetchCursorUsageExport({ ...base, cookie: undefined }, { fetch: f.impl })).toBeNull();
    expect(f.calls).toEqual([]);
  });
});

describe('usage-export request', () => {
  it('authenticates with the session cookie, never a bearer token', async () => {
    const f = recordingFetch();
    await fetchCursorUsageExport(base, { fetch: f.impl });
    expect(f.calls).toHaveLength(1);
    const headers = f.calls[0].init?.headers ?? {};
    expect(headers.Cookie).toBe(`WorkosCursorSessionToken=${FAKE_COOKIE}`);
    expect(headers.Authorization).toBeUndefined();
  });

  it('passes the report window through as date parameters', async () => {
    const f = recordingFetch();
    await fetchCursorUsageExport(base, { fetch: f.impl });
    const url = new URL(f.calls[0].url);
    expect(url.searchParams.get('startDate')).toBe('2026-08-29');
    expect(url.searchParams.get('endDate')).toBe('2026-09-05');
  });

  it('feeds the response through the same parser as the file import', async () => {
    const f = recordingFetch();
    const out = (await fetchCursorUsageExport(base, { fetch: f.impl }))!;
    expect(out.events).toHaveLength(8);
    expect(out.totals.costUSD).toBeCloseTo(3.87, 2);
    expect(out.sourceFile).toBeUndefined(); // fetched, not read from disk
  });
});

describe('usage-export failure handling', () => {
  it.each([401, 403, 500])('degrades to null on HTTP %i', async (status) => {
    const f = recordingFetch(() => ({ status }));
    expect(await fetchCursorUsageExport(base, { fetch: f.impl })).toBeNull();
  });

  it('degrades to null when the body is not a usage export', async () => {
    const f = recordingFetch(() => ({ body: '<!doctype html><title>Sign in</title>' }));
    expect(await fetchCursorUsageExport(base, { fetch: f.impl })).toBeNull();
  });

  it('survives a transport throw', async () => {
    const impl = async () => { throw new Error('ENOTFOUND cursor.example'); };
    expect(await fetchCursorUsageExport(base, { fetch: impl as never })).toBeNull();
  });
});

describe('session token confidentiality', () => {
  let logged: string[];
  beforeEach(async () => {
    logged = [];
    const { logger } = await import('@/utils/logger.js');
    vi.spyOn(logger, 'debug').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('never writes the cookie to a log line, on success or on failure', async () => {
    await fetchCursorUsageExport(base, { fetch: recordingFetch().impl });
    await fetchCursorUsageExport(base, { fetch: recordingFetch(() => ({ status: 401 })).impl });
    const all = logged.join('\n');
    expect(all).not.toContain(FAKE_COOKIE);
    expect(all).not.toContain(FAKE_JWT);
    expect(all).not.toContain(FAKE_USER_ID);
  });
});

describe('readCursorSessionCookie', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cursor-cookie-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined when the state database is absent', async () => {
    expect(await readCursorSessionCookie(join(dir, 'missing.vscdb'))).toBeUndefined();
  });

  it('returns undefined for a file that is not a database', async () => {
    const p = join(dir, 'state.vscdb');
    writeFileSync(p, 'not a database');
    expect(await readCursorSessionCookie(p)).toBeUndefined();
  });
});

describe('explicitly supplied session token', () => {
  it('prefers CURSOR_SESSION_TOKEN over any store lookup', async () => {
    const cookie = await readCursorSessionCookie('/no/such/state.vscdb', { CURSOR_SESSION_TOKEN: FAKE_COOKIE });
    expect(cookie).toBe(FAKE_COOKIE);
  });

  it('rejects a supplied value that is not of the documented shape', async () => {
    const cookie = await readCursorSessionCookie('/no/such/state.vscdb', { CURSOR_SESSION_TOKEN: 'crsr_someadminapikey' });
    expect(cookie).toBeUndefined();
  });
});
