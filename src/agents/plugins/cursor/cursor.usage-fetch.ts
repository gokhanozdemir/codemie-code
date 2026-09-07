/**
 * Cookie-authenticated fetch of the Cursor usage export.
 *
 * This is a convenience wrapper around exactly one thing: getting the same CSV that
 * `--cursor-usage-csv` reads from disk, without the operator clicking Export by hand. It parses
 * the result through {@link parseCursorUsageCsv} — one code path, so the fetched and the
 * downloaded file can never diverge in interpretation.
 *
 * Three deliberate constraints, because this handles a live session credential:
 *
 * 1. **The endpoint is not hardcoded.** Cursor's dashboard export is undocumented and can change
 *    or vanish without notice, so CodeMie ships no URL and asserts nothing about one: the
 *    operator supplies `CURSOR_USAGE_EXPORT_URL`. A product that bakes in an undocumented
 *    endpoint quietly breaks when the vendor moves it; this one simply does nothing.
 * 2. **Auth is the browser session cookie, never a `crsr_` API key.** The Team Analytics admin
 *    key is rejected by this endpoint (401) and is a different credential for a different API.
 * 3. **The token never reaches a log line.** It is read, put in one header, and dropped. Failure
 *    messages name the status code and the endpoint host, never the credential.
 *
 * File import remains the supported path. This is strictly opt-in and fail-soft: anything that
 * goes wrong omits the section and leaves the local report — which always works — untouched.
 *
 * On where the cookie comes from: it is a *browser* cookie for cursor.com, so on a signed-in
 * machine it lives in the Electron app's Chromium cookie jar, encrypted against the OS keychain.
 * CodeMie does not decrypt that — prying a credential out of another application's protected
 * store is not something an analytics command should do. {@link readCursorSessionCookie} makes a
 * cheap, read-only attempt at Cursor's own plaintext state database (harmless if it finds
 * nothing), and otherwise the operator supplies the value explicitly via `CURSOR_SESSION_TOKEN`,
 * which keeps handing over a credential a deliberate act.
 */

import { existsSync } from 'node:fs';
import { logger } from '@/utils/logger.js';
import { getCursorStateDbPath } from './cursor.paths.js';
import { parseCursorUsageCsv, type CursorUsageImport } from './cursor.usage-csv.js';

/** The cookie Cursor's dashboard authenticates with: `<userId>::<accessToken>`. */
const COOKIE_NAME = 'WorkosCursorSessionToken';

/**
 * A session cookie value is `<userId>::<jwt>`. Matching on the shape rather than on a fixed
 * key name means a renamed storage key does not silently break the reader — and, more
 * importantly, that we never treat some other opaque secret as if it were this one.
 */
const COOKIE_SHAPE = /^[\w-]+::[\w-]+\.[\w-]+\.[\w-]+$/;

export interface UsageFetchRequest {
  /** Explicit per-invocation opt-in. A readable cookie on disk is never sufficient by itself. */
  enabled: boolean;
  /** Operator-supplied export endpoint. Absent means no request is made. */
  exportUrl?: string;
  /** `<userId>::<jwt>`, normally from {@link readCursorSessionCookie}. */
  cookie?: string;
  startDate?: string;
  endDate?: string;
  /** Restrict imported rows to one `User` value, as the file import does. */
  userEmail?: string;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface UsageFetchDeps {
  fetch: FetchLike;
}

/** Host only — enough to debug a failure without ever naming the credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured endpoint';
  }
}

async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite');
  } catch {
    // Node < 22.5 has no node:sqlite. Same fail-soft contract as the rest of the plugin.
    logger.debug('[cursor] node:sqlite unavailable; cannot read the session cookie');
    return null;
  }
}

/**
 * Read the signed-in session cookie out of Cursor's own state database.
 *
 * Read-only and fail-soft by mandate (ADR 0001): an absent file, an old Node, a renamed table,
 * a corrupt or locked database, or simply not being signed in all return `undefined` rather
 * than throwing. Candidate rows are matched on {@link COOKIE_SHAPE}, so a storage-key rename
 * does not break this and no unrelated secret is mistaken for the cookie.
 *
 * Returns the raw cookie value. Callers must not log it.
 */
export async function readCursorSessionCookie(
  dbPath: string = getCursorStateDbPath(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  // An explicitly-provided value always wins: it is the documented way in, and it means the
  // operator chose to hand over the credential rather than having it lifted from an app store.
  const supplied = env.CURSOR_SESSION_TOKEN?.trim();
  if (supplied) {
    if (COOKIE_SHAPE.test(supplied)) {
      return supplied;
    }
    logger.debug('[cursor] CURSOR_SESSION_TOKEN is set but is not of the form <userId>::<jwt>');
    return undefined;
  }

  if (!existsSync(dbPath)) {
    logger.debug('[cursor] no state database; cannot read the session cookie');
    return undefined;
  }
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return undefined;
  }

  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT value FROM ItemTable
          WHERE key LIKE '%${COOKIE_NAME}%' OR key LIKE 'cursorAuth%'`
      )
      .all() as { value?: unknown }[];
    for (const row of rows) {
      const value = typeof row.value === 'string' ? row.value.trim() : undefined;
      if (value && COOKIE_SHAPE.test(value)) {
        return value;
      }
    }
    logger.debug('[cursor] no session cookie found in the state database (signed out?)');
    return undefined;
  } catch (error) {
    logger.debug(`[cursor] state database unusable while reading the session cookie: ${(error as Error).message}`);
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a failed open is not an error worth reporting */
    }
  }
}

/**
 * Fetch and parse the usage export. Returns `null` whenever the gate is shut or anything at all
 * goes wrong — the caller simply omits the section.
 */
export async function fetchCursorUsageExport(
  req: UsageFetchRequest,
  deps: UsageFetchDeps = { fetch: globalThis.fetch as unknown as FetchLike }
): Promise<CursorUsageImport | null> {
  if (!req.enabled || !req.exportUrl || !req.cookie) {
    logger.debug('[cursor] usage export fetch skipped (needs the opt-in flag, an export URL, and a session cookie)');
    return null;
  }

  let url: string;
  try {
    const u = new URL(req.exportUrl);
    if (req.startDate) {
      u.searchParams.set('startDate', req.startDate);
    }
    if (req.endDate) {
      u.searchParams.set('endDate', req.endDate);
    }
    url = u.toString();
  } catch {
    logger.debug('[cursor] CURSOR_USAGE_EXPORT_URL is not a valid URL');
    return null;
  }

  try {
    const res = await deps.fetch(url, {
      headers: { Cookie: `${COOKIE_NAME}=${req.cookie}`, Accept: 'text/csv' },
    });
    if (!res.ok) {
      // Status and host only — naming the credential here is how secrets end up in bug reports.
      logger.debug(`[cursor] usage export fetch returned HTTP ${res.status} from ${hostOf(url)}`);
      return null;
    }
    const parsed = parseCursorUsageCsv(await res.text(), {
      ...(req.userEmail !== undefined && { userEmail: req.userEmail }),
    });
    if (!parsed) {
      // A sign-in redirect returns 200 with an HTML body; that is not an export.
      logger.debug(`[cursor] usage export response from ${hostOf(url)} was not a usage CSV`);
      return null;
    }
    return parsed;
  } catch (error) {
    logger.debug(`[cursor] usage export fetch failed against ${hostOf(url)}: ${(error as Error).message}`);
    return null;
  }
}
