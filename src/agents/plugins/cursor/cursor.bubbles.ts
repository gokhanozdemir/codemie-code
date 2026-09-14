/**
 * Per-turn enrichment from Cursor's internal `state.vscdb` — the `cursorDiskKV` table.
 *
 * `cursorDiskKV` is VS Code/Cursor's own undocumented internal key/value store, not a stable
 * public API (see `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`). It holds one
 * row per bubble (turn/message) keyed `bubbleId:<composerId>:<bubbleId>`, interleaved with
 * unrelated `composerData:*` keys and, in aggregate, up to ~1.4GB of unrelated VS Code state —
 * so every read here filters by `composerId` in SQL rather than scanning the whole table.
 *
 * Each bubble row carries a `toolFormerData.status` (`completed` / `error` / `cancelled` /
 * `loading`) and `toolFormerData.name`, used to build per-tool success/failure counts, plus a
 * sparse `tokenCount: {inputTokens, outputTokens}` present on roughly 1% of bubbles — enough to
 * signal that partial pricing is possible, not enough to guarantee full coverage.
 *
 * Everything here is fail-soft by mandate, exactly like `cursor.state-db.ts`: an absent file, an
 * absent `node:sqlite` (Node < 22.5), a renamed table or column, a corrupt file, a locked
 * database, or a malformed individual row all degrade to a zeroed-out summary — never a thrown
 * error. A single malformed row must not lose the rest of the bubbles.
 *
 * Reads are strictly read-only: the database is opened with `readOnly: true` and only
 * SELECTed, with the composerId parameterized (never interpolated) into the query.
 */

import { existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { getCursorStateDbPath } from './cursor.paths.js';

/** Aggregated tool-outcome and token-usage signal for one Cursor Agent conversation's bubbles. */
export interface CursorBubbleSummary {
  /** Per-tool success/failure counts, keyed by toolFormerData.name. Only tools with a resolved (non-'loading') status are counted. */
  toolStatus: Record<string, { success: number; failure: number }>;
  /** Sum of inputTokens across every bubble that had a tokenCount object, however sparse. */
  totalInputTokens: number;
  /** Sum of outputTokens across every bubble that had a tokenCount object. */
  totalOutputTokens: number;
  /** True iff at least one bubble carried a nonzero inputTokens or outputTokens — the signal that gates partial pricing. */
  hasTokenSignal: boolean;
}

function emptySummary(): CursorBubbleSummary {
  return { toolStatus: {}, totalInputTokens: 0, totalOutputTokens: 0, hasTokenSignal: false };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asPositiveNumber(value: unknown): number {
  const num = asNumber(value);
  return num !== undefined && num > 0 ? num : 0;
}

/** A `cursorDiskKV` bubble row in either of its possible shapes — never assumed, always guarded. */
interface BubbleRow {
  key?: unknown;
  value?: unknown;
  toolFormerData?: unknown;
  tokenCount?: unknown;
}

/**
 * Escape `%`, `_`, and `\` in a LIKE pattern fragment so a composerId containing them cannot
 * widen or corrupt the match. composerIds are expected to be UUID-like, but this is never
 * trusted — the value ultimately comes from Cursor's own undocumented, unversioned storage.
 */
function escapeLikeFragment(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * `toolFormerData` may arrive as a plain object (flat-column row shape) or, after JSON-parsing
 * a key/value row's `value` blob, as a parsed object too — same shape either way, just guarded
 * defensively since SQLite hands back `unknown` in both cases.
 */
function applyToolStatus(
  toolFormerData: unknown,
  toolStatus: Record<string, { success: number; failure: number }>
): boolean {
  if (!toolFormerData || typeof toolFormerData !== 'object') {
    return false;
  }

  const name = asString((toolFormerData as { name?: unknown }).name);
  if (!name) {
    // Can't attribute an outcome to nothing.
    return false;
  }

  const status = asString((toolFormerData as { status?: unknown }).status);
  if (status !== 'completed' && status !== 'error' && status !== 'cancelled') {
    // 'loading' or any other/missing status is not a resolved outcome.
    return false;
  }

  const counts = (toolStatus[name] ??= { success: 0, failure: 0 });
  if (status === 'completed') {
    counts.success += 1;
  } else {
    counts.failure += 1;
  }
  return true;
}

/**
 * `tokenCount` may arrive as a plain object (flat-column row shape) or a parsed JSON object
 * (key/value row shape) — same guarded handling either way.
 */
function applyTokenCount(
  tokenCount: unknown,
  summary: CursorBubbleSummary
): boolean {
  if (!tokenCount || typeof tokenCount !== 'object') {
    return false;
  }

  const inputTokens = asPositiveNumber((tokenCount as { inputTokens?: unknown }).inputTokens);
  const outputTokens = asPositiveNumber((tokenCount as { outputTokens?: unknown }).outputTokens);

  summary.totalInputTokens += inputTokens;
  summary.totalOutputTokens += outputTokens;

  return inputTokens > 0 || outputTokens > 0;
}

/**
 * `node:sqlite`, or null where it does not exist.
 *
 * The repository supports Node >= 20 and `node:sqlite` only landed in 22.5, so this cannot be a
 * static import: on Node 20 it would throw at module load and take the whole analytics run
 * down. Cursor bubble enrichment from `state.vscdb` is optional — older runtimes simply see no
 * tool/token signal from this source.
 */
async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    logger.debug('[cursor] node:sqlite unavailable — skipping bubble summary:', error);
    return null;
  }
}

/**
 * Summarize tool outcomes and token usage across every bubble belonging to one Cursor Agent
 * conversation, or a zeroed-out summary when the database cannot be read.
 *
 * Never throws.
 */
export async function readCursorBubbles(
  composerId: string,
  dbPath: string = getCursorStateDbPath()
): Promise<CursorBubbleSummary> {
  const summary = emptySummary();

  if (!existsSync(dbPath)) {
    logger.debug(`[cursor] no state database at ${dbPath}`);
    return summary;
  }

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return summary;
  }

  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  let toolOutcomeCount = 0;
  let tokenSignalCount = 0;
  let scannedCount = 0;

  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const pattern = `bubbleId:${escapeLikeFragment(composerId)}:%`;
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\'")
      .all(pattern) as BubbleRow[];

    for (const row of rows) {
      scannedCount += 1;
      try {
        let toolFormerData: unknown;
        let tokenCount: unknown;

        const value = asString(row.value);
        if (value) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch (error) {
            logger.debug(`[cursor] unparsable cursorDiskKV value for key "${String(row.key)}":`, error);
            continue;
          }
          if (!parsed || typeof parsed !== 'object') {
            continue;
          }
          const parsedRow = parsed as BubbleRow;
          toolFormerData = parsedRow.toolFormerData;
          tokenCount = parsedRow.tokenCount;
        } else {
          toolFormerData = row.toolFormerData;
          tokenCount = row.tokenCount;
        }

        if (applyToolStatus(toolFormerData, summary.toolStatus)) {
          toolOutcomeCount += 1;
        }
        if (applyTokenCount(tokenCount, summary)) {
          tokenSignalCount += 1;
          summary.hasTokenSignal = true;
        }
      } catch (error) {
        // A single malformed row must not lose the rest of the bubbles.
        logger.debug('[cursor] skipping unreadable cursorDiskKV row:', error);
      }
    }
  } catch (error) {
    // Missing table, renamed column, corrupt file, locked database — all the same to us.
    logger.debug(`[cursor] state database unusable at ${dbPath}:`, error);
    return emptySummary();
  } finally {
    try {
      db?.close();
    } catch {
      // closing a database we failed to open is not an error worth reporting
    }
  }

  logger.debug(
    `[cursor] bubble summary for composer ${composerId} scanned ${scannedCount} bubble(s): ` +
      `${toolOutcomeCount} with a tool outcome, ${tokenSignalCount} with a token signal`
  );

  return summary;
}
