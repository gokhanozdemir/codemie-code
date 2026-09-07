/**
 * Shared read-only helpers for the Cursor plugin's SQLite readers.
 *
 * Every reader here follows the same fail-soft contract (ADR 0001): an absent database, an old
 * Node without `node:sqlite`, a renamed table/column, or a corrupt/locked file degrades to
 * "no enrichment" rather than throwing. These helpers hold the parts that were otherwise
 * copy-pasted across `cursor.tracking-db.ts`, `cursor.state-db.ts`, `cursor.bubbles.ts`, and
 * `cursor.usage-fetch.ts`.
 */

import { logger } from '@/utils/logger.js';

/**
 * `node:sqlite`, or null where it does not exist.
 *
 * The repository supports Node >= 20 and `node:sqlite` only landed in 22.5, so this cannot be a
 * static import: on Node 20 it would throw at module load and take the whole analytics run
 * down. Every caller is optional enrichment, so an older runtime simply sees no signal from
 * that source. `purpose` names what is being skipped, for the debug log only.
 */
export async function loadSqlite(purpose: string): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    logger.debug(`[cursor] node:sqlite unavailable — skipping ${purpose}:`, error);
    return null;
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
