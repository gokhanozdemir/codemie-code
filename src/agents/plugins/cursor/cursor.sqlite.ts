/**
 * Shared read-only helpers for the Cursor plugin's SQLite readers.
 *
 * Every reader here follows the same fail-soft contract: an absent database, an old
 * Node without `node:sqlite`, a renamed table/column, or a corrupt/locked file degrades to
 * "no enrichment" rather than throwing. These helpers hold the parts that were otherwise
 * copy-pasted across `cursor.tracking-db.ts`, `cursor.state-db.ts`, `cursor.bubbles.ts`, and
 * `cursor.usage-fetch.ts`.
 */

import { existsSync } from 'fs';
import { logger } from '@/utils/logger.js';

type SqliteModule = typeof import('node:sqlite');
/** An open `node:sqlite` `DatabaseSync` handle. */
export type SqliteDb = InstanceType<SqliteModule['DatabaseSync']>;

/**
 * `node:sqlite`, or null where it does not exist.
 *
 * The repository supports Node >= 20 and `node:sqlite` only landed in 22.5, so this cannot be a
 * static import: on Node 20 it would throw at module load and take the whole analytics run
 * down. Every caller is optional enrichment, so an older runtime simply sees no signal from
 * that source. `purpose` names what is being skipped, for the debug log only.
 */
export async function loadSqlite(purpose: string): Promise<SqliteModule | null> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    logger.debug(`[cursor] node:sqlite unavailable — skipping ${purpose}:`, error);
    return null;
  }
}

/**
 * Open one of Cursor's SQLite stores read-only, hand it to `query`, and always close it —
 * the shared shell around the open/query/close try-finally that used to be copy-pasted into
 * `cursor.bubbles.ts`, `cursor.state-db.ts`, `cursor.tracking-db.ts`, and `cursor.usage-fetch.ts`.
 *
 * Fail-soft by the same mandate as every other reader in this plugin: a missing file, an absent
 * `node:sqlite` (Node < 22.5), or a query failure (missing table, renamed column, corrupt file,
 * locked database) all return `fallback` instead of throwing. `purpose` names what is being
 * skipped for the `loadSqlite` debug log; `label` names the database for the "unusable" log on
 * query failure.
 */
export async function withReadOnlyDb<T>(
  dbPath: string,
  purpose: string,
  label: string,
  fallback: T,
  query: (db: SqliteDb) => T
): Promise<T> {
  if (!existsSync(dbPath)) {
    logger.debug(`[cursor] no ${label} at ${dbPath}`);
    return fallback;
  }

  const sqlite = await loadSqlite(purpose);
  if (!sqlite) {
    return fallback;
  }

  let db: SqliteDb | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return query(db);
  } catch (error) {
    logger.debug(`[cursor] ${label} unusable at ${dbPath}:`, error);
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // closing a database we failed to open is not an error worth reporting
    }
  }
}

/** A non-empty string, or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A finite number, or undefined. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A positive finite epoch-ms timestamp, or undefined. */
export function asEpochMs(value: unknown): number | undefined {
  const num = asNumber(value);
  return num !== undefined && num > 0 ? num : undefined;
}

/** A loose boolean, tolerating the `1`/`'true'`/`'1'` shapes SQLite/JSON rows use. */
export function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}
