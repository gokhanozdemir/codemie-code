/**
 * Read-only enrichment from Cursor's AI-tracking database.
 *
 * A Cursor agent transcript records role-tagged text and turn markers and NOTHING else — no
 * timestamps, no model, no token counts. `~/.cursor/ai-tracking/ai-code-tracking.db` is the
 * only local store that carries the missing facts, and it joins to a transcript on the
 * conversation id (which is the transcript's own file/directory name).
 *
 * Everything here is fail-soft by mandate. The schema is undocumented and Cursor may change
 * it in any release, so an absent file, an absent `node:sqlite` (Node < 22.5), a renamed
 * table or a renamed column all degrade to "no enrichment" — the transcripts still produce
 * session rows, just without model, files or an activity window. A Cursor update must never
 * break `codemie analytics`.
 *
 * Reads are strictly read-only: the database is opened with `readOnly` and only SELECTed.
 */

import { logger } from '@/utils/logger.js';
import { CURSOR_AUTO_MODEL_LABEL, CURSOR_AUTO_MODEL_SENTINEL } from './cursor.constants.js';
import { getCursorTrackingDbPath } from './cursor.paths.js';
import { asEpochMs, asString, withReadOnlyDb } from './cursor.sqlite.js';

/** What the tracking database knows about one conversation. */
export interface CursorConversationActivity {
  /** Epoch ms of the first recorded edit, when any. */
  firstEditMs?: number;
  /** Epoch ms of the last recorded edit, when any. */
  lastEditMs?: number;
  /** Absolute paths Cursor recorded itself as having written in this conversation. */
  files: string[];
  /**
   * Models Cursor attributed edits to.
   *
   * The literal `default` never appears: it is Cursor's sentinel for delegated model choice and
   * names no model, so it is reported as `Auto` — the term Cursor's own usage export uses for
   * the same conversations. What is never done is stamping the session with whatever model
   * Cursor happens to default to today.
   */
  models: string[];
}

/** Conversation id → enrichment. An empty map means "no enrichment available". */
export type CursorTrackingIndex = Map<string, CursorConversationActivity>;

/**
 * Only `composer` rows are agent-written. `human` rows are the user's own edits that Cursor
 * tracked for its AI-percentage stats, and counting them would attribute human work to the
 * agent.
 */
const ACTIVITY_QUERY = `
  SELECT conversationId AS id,
         fileName       AS file,
         model          AS model,
         MIN(timestamp) AS firstMs,
         MAX(timestamp) AS lastMs
    FROM ai_code_hashes
   WHERE source = 'composer'
     AND conversationId IS NOT NULL
   GROUP BY conversationId, fileName, model
`;

interface ActivityRow {
  id?: unknown;
  file?: unknown;
  model?: unknown;
  firstMs?: unknown;
  lastMs?: unknown;
}

/**
 * Build the conversation → activity index, or an empty map when the database cannot be read.
 *
 * Never throws.
 */
export async function readCursorTrackingIndex(
  dbPath: string = getCursorTrackingDbPath()
): Promise<CursorTrackingIndex> {
  const index = await withReadOnlyDb(
    dbPath,
    'tracking enrichment',
    'ai-tracking database',
    new Map() as CursorTrackingIndex,
    (db) => {
      const found: CursorTrackingIndex = new Map();
      const rows = db.prepare(ACTIVITY_QUERY).all() as ActivityRow[];

      for (const row of rows) {
        const id = asString(row.id);
        if (!id) {
          continue;
        }
        const entry = found.get(id) ?? { files: [], models: [] };

        const file = asString(row.file);
        if (file && !entry.files.includes(file)) {
          entry.files.push(file);
        }

        // `default` is Cursor's sentinel for "you pick" — reported under the name Cursor's own
        // dashboard gives it rather than dropped, so the row reads "Auto" instead of blank.
        const raw = asString(row.model);
        const model = raw === CURSOR_AUTO_MODEL_SENTINEL ? CURSOR_AUTO_MODEL_LABEL : raw;
        if (model && !entry.models.includes(model)) {
          entry.models.push(model);
        }

        const firstMs = asEpochMs(row.firstMs);
        if (firstMs !== undefined && (entry.firstEditMs === undefined || firstMs < entry.firstEditMs)) {
          entry.firstEditMs = firstMs;
        }
        const lastMs = asEpochMs(row.lastMs);
        if (lastMs !== undefined && (entry.lastEditMs === undefined || lastMs > entry.lastEditMs)) {
          entry.lastEditMs = lastMs;
        }

        found.set(id, entry);
      }

      return found;
    }
  );

  logger.debug(`[cursor] tracking index covers ${index.size} conversation(s)`);
  return index;
}
