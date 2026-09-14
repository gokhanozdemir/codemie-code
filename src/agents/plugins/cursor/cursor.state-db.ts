/**
 * Session discovery from Cursor's internal `state.vscdb` — the `composerHeaders` table.
 *
 * `state.vscdb` is VS Code/Cursor's own undocumented internal state store, not a stable public
 * API (see `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`). `composerHeaders`
 * holds one row per Cursor Agent conversation, keyed by `composerId` — the same identifier used
 * as the `agent-transcripts` directory name and `ai_code_hashes.conversationId` elsewhere in
 * this plugin. Its row shape is unconfirmed: it may be flat columns, or (as is common for
 * VS Code/Cursor internal tables) a `key TEXT, value TEXT` pair with `value` holding a JSON
 * blob. Both shapes are handled defensively below.
 *
 * Everything here is fail-soft by mandate, exactly like `cursor.tracking-db.ts`: an absent
 * file, an absent `node:sqlite` (Node < 22.5), a renamed table or column, a corrupt file, or a
 * locked database all degrade to an empty index — never a thrown error. A single malformed row
 * must not lose the rest of the table.
 *
 * Draft sessions (`isDraft: true`) are never started, so surfacing them as discoverable
 * sessions would be misleading; they are filtered out before entering the returned index.
 *
 * Reads are strictly read-only: the database is opened with `readOnly: true` and only
 * SELECTed.
 */

import { existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { getCursorStateDbPath } from './cursor.paths.js';

/** What `composerHeaders` knows about one Cursor Agent conversation. */
export interface CursorComposerHeader {
  /** The conversation id — shared with `agent-transcripts` and `ai_code_hashes`. */
  composerId: string;
  /** Absolute workspace path, resolved from `workspaceIdentifier.uri.fsPath`, when present. */
  projectPath?: string;
  /** Git branch the conversation ran on, when Cursor recorded one. */
  branch?: string;
  /** Epoch ms the conversation was created, when recorded. */
  createdAt?: number;
  /** Epoch ms the conversation was last updated, when recorded. */
  updatedAt?: number;
  /** Total lines added across the conversation, when recorded. */
  linesAdded?: number;
  /** Total lines removed across the conversation, when recorded. */
  linesRemoved?: number;
  /** Count of files touched across the conversation, when recorded. */
  filesChangedCount?: number;
}

/** composerId → header. An empty map means "no sessions discoverable". */
export type CursorComposerIndex = Map<string, CursorComposerHeader>;

/** A `composerHeaders` row in either of its possible shapes — never assumed, always guarded. */
interface ComposerRow {
  key?: unknown;
  value?: unknown;
  composerId?: unknown;
  workspaceIdentifier?: unknown;
  activeBranch?: unknown;
  createdOnBranch?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  totalLinesAdded?: unknown;
  totalLinesRemoved?: unknown;
  filesChangedCount?: unknown;
  isDraft?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asEpochMs(value: unknown): number | undefined {
  const num = asNumber(value);
  return num !== undefined && num > 0 ? num : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * `workspaceIdentifier.uri.fsPath` may be a plain string field, or (rarer, seen on some Cursor
 * builds) a `file://…` URI string in place of the object. Both decode to the same absolute
 * path; anything else is not a shape this loader recognizes and leaves `projectPath` undefined.
 */
function extractProjectPath(workspaceIdentifier: unknown): string | undefined {
  if (!workspaceIdentifier || typeof workspaceIdentifier !== 'object') {
    return undefined;
  }

  const uri = (workspaceIdentifier as { uri?: unknown }).uri;

  if (typeof uri === 'string') {
    return decodeFileUri(uri);
  }

  if (uri && typeof uri === 'object') {
    const fsPath = asString((uri as { fsPath?: unknown }).fsPath);
    if (fsPath) {
      return fsPath;
    }
  }

  return undefined;
}

function decodeFileUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) {
    return undefined;
  }

  try {
    return decodeURIComponent(uri.slice('file://'.length)) || undefined;
  } catch (error) {
    logger.debug(`[cursor] unable to decode file URI "${uri}":`, error);
    return undefined;
  }
}

function extractBranch(row: {
  activeBranch?: unknown;
  createdOnBranch?: unknown;
}): string | undefined {
  if (row.activeBranch && typeof row.activeBranch === 'object') {
    const branchName = asString((row.activeBranch as { branchName?: unknown }).branchName);
    if (branchName) {
      return branchName;
    }
  }

  return asString(row.createdOnBranch);
}

/**
 * `key` is only present on the key/value table shape and, when it names a composerId at all,
 * commonly prefixes it (e.g. `composerHeaderData:<composerId>`). Take the last `:`-delimited
 * segment either way — a bare id round-trips through this unchanged.
 */
function composerIdFromKey(key: unknown): string | undefined {
  const raw = asString(key);
  if (!raw) {
    return undefined;
  }
  const segments = raw.split(':');
  return asString(segments[segments.length - 1]);
}

function normalizeHeader(source: {
  composerId?: unknown;
  workspaceIdentifier?: unknown;
  activeBranch?: unknown;
  createdOnBranch?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  totalLinesAdded?: unknown;
  totalLinesRemoved?: unknown;
  filesChangedCount?: unknown;
}): Omit<CursorComposerHeader, 'composerId'> {
  return {
    projectPath: extractProjectPath(source.workspaceIdentifier),
    branch: extractBranch(source),
    createdAt: asEpochMs(source.createdAt),
    updatedAt: asEpochMs(source.updatedAt),
    linesAdded: asNumber(source.totalLinesAdded),
    linesRemoved: asNumber(source.totalLinesRemoved),
    filesChangedCount: asNumber(source.filesChangedCount),
  };
}

/**
 * `node:sqlite`, or null where it does not exist.
 *
 * The repository supports Node >= 20 and `node:sqlite` only landed in 22.5, so this cannot be a
 * static import: on Node 20 it would throw at module load and take the whole analytics run
 * down. Cursor session discovery from `state.vscdb` is optional — older runtimes simply see no
 * Cursor sessions from this source.
 */
async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    logger.debug('[cursor] node:sqlite unavailable — skipping composer index:', error);
    return null;
  }
}

/**
 * Build the composerId → header index, or an empty map when the database cannot be read.
 *
 * Never throws.
 */
export async function readCursorComposerIndex(
  dbPath: string = getCursorStateDbPath()
): Promise<CursorComposerIndex> {
  const index: CursorComposerIndex = new Map();

  if (!existsSync(dbPath)) {
    logger.debug(`[cursor] no state database at ${dbPath}`);
    return index;
  }

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return index;
  }

  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT * FROM composerHeaders').all() as ComposerRow[];

    for (const row of rows) {
      try {
        let composerId: string | undefined;
        let header: Omit<CursorComposerHeader, 'composerId'>;
        let isDraft: unknown;

        const value = asString(row.value);
        if (value !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch (error) {
            logger.debug(`[cursor] unparsable composerHeaders value for key "${String(row.key)}":`, error);
            continue;
          }

          if (!parsed || typeof parsed !== 'object') {
            continue;
          }

          const parsedRow = parsed as ComposerRow;
          composerId = asString(parsedRow.composerId) ?? composerIdFromKey(row.key);
          header = normalizeHeader(parsedRow);
          isDraft = parsedRow.isDraft;
        } else {
          composerId = asString(row.composerId);
          header = normalizeHeader(row);
          isDraft = row.isDraft;
        }

        if (!composerId) {
          continue;
        }

        if (asBoolean(isDraft)) {
          continue;
        }

        index.set(composerId, { composerId, ...header });
      } catch (error) {
        // A single malformed row must not lose the rest of the table.
        logger.debug('[cursor] skipping unreadable composerHeaders row:', error);
      }
    }
  } catch (error) {
    // Missing table, renamed column, corrupt file, locked database — all the same to us.
    logger.debug(`[cursor] state database unusable at ${dbPath}:`, error);
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      // closing a database we failed to open is not an error worth reporting
    }
  }

  logger.debug(`[cursor] composer index covers ${index.size} session(s)`);
  return index;
}
