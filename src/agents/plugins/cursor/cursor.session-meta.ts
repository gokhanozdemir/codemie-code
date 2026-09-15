/**
 * Per-session timing, project-path, and usage-provenance resolution for the Cursor adapter.
 *
 * These combine `composerHeaders`, the AI-tracking database, the transcript's own prompt stamps,
 * and the transcript file's own stat as a fallback chain — see `cursor.session.ts`'s module doc
 * comment for why each source is preferred over the next.
 */

import { statSync } from 'fs';
import type { ParsedSession } from '../../core/session/BaseSessionAdapter.js';
import type { CursorComposerHeader } from './cursor.state-db.js';
import type { CursorConversationActivity } from './cursor.tracking-db.js';
import type { CursorBubbleSummary } from './cursor.bubbles.js';
import { transcriptStampWindow } from './cursor.transcript.js';
import { projectPathFromFiles, projectPathFromSlug } from './cursor.project-path.js';
import { logger } from '@/utils/logger.js';

/**
 * Why a Cursor session has no priced usage — used only when `cursorDiskKV` carried no token
 * signal for it at all (see {@link resolveUsageMeta}; most sessions, since the per-turn
 * `tokenCount` field is present on roughly 1% of bubbles). Reporting zero cost
 * would read as "this session was free"; the reason string makes the report say "unmeasurable"
 * instead.
 */
const NO_USAGE_REASON =
  "Cursor records token usage on only a sparse fraction of turns — this session's bubbles carried none, so cost cannot be derived";

/**
 * When the transcript file was created and last written.
 *
 * Some filesystems report a zero birthtime; mtime is then the only timestamp available and
 * collapses the window to a point, which is still truthful about "when this happened".
 */
function fileWindow(filePath: string): { createdAt: number; updatedAt: number } | undefined {
  try {
    const stats = statSync(filePath);
    const updatedAt = stats.mtimeMs;
    const birth = stats.birthtimeMs;
    return { createdAt: birth > 0 ? birth : updatedAt, updatedAt };
  } catch (error) {
    logger.debug(`[cursor-discovery] cannot stat transcript ${filePath}:`, error);
    return undefined;
  }
}

/**
 * When a conversation ran, best source first.
 *
 * Cursor's own recorded edits are the strongest signal but exist only for conversations that
 * changed a file. The prompt stamps in the transcript cover the rest and still describe the
 * work rather than the file, so they come before the file's own times — those measure when the
 * transcript was touched and stretch a resumed conversation across the whole gap.
 */
function activityWindow(
  filePath: string,
  activity: CursorConversationActivity | undefined
): { createdAt: number; updatedAt: number } | undefined {
  // Either end can be missing on its own — a database row can record a first edit and no last —
  // so the stamps are read whenever either end is still open, not only when both are.
  const needsStamps = activity?.firstEditMs === undefined || activity?.lastEditMs === undefined;
  const stamps = needsStamps ? transcriptStampWindow(filePath) : undefined;
  const createdAt = activity?.firstEditMs ?? stamps?.firstMs;
  const updatedAt = activity?.lastEditMs ?? stamps?.lastMs;

  if (createdAt === undefined || updatedAt === undefined) {
    const file = fileWindow(filePath);
    if (!file) {
      return undefined;
    }
    return {
      createdAt: createdAt ?? file.createdAt,
      updatedAt: Math.max(createdAt ?? file.createdAt, updatedAt ?? file.updatedAt),
    };
  }

  return { createdAt, updatedAt: Math.max(createdAt, updatedAt) };
}

/**
 * When a conversation ran, preferring `composerHeaders`'s own timestamps over anything derived.
 *
 * A header can record only one end of the window (Cursor's own writes are not guaranteed
 * complete either). The header always wins for the end it does record; the open end falls
 * through to the recorded edit times rather than mirroring the closed one, which would claim a
 * zero-length session for work that plainly ran on.
 */
export function resolveWindow(
  header: CursorComposerHeader | undefined,
  filePath: string,
  activity: CursorConversationActivity | undefined
): { createdAt: number; updatedAt: number } | undefined {
  if (header?.createdAt === undefined && header?.updatedAt === undefined) {
    return activityWindow(filePath, activity);
  }

  const createdAt = header.createdAt ?? header.updatedAt!;
  if (header.updatedAt !== undefined) {
    return { createdAt, updatedAt: Math.max(createdAt, header.updatedAt) };
  }

  // Only one end recorded. Mirroring `createdAt` would report a zero-length session for work
  // that demonstrably continued — about half of a real `composerHeaders` table dates only its
  // creation — so the weaker sources close the open end, and only that end.
  const derived = activityWindow(filePath, activity);
  return { createdAt, updatedAt: Math.max(createdAt, derived?.updatedAt ?? createdAt) };
}

/**
 * The project path for a conversation: `composerHeaders`'s own `workspaceIdentifier.uri.fsPath`
 * when the session has a header, with no slug-guessing needed at all — that is the whole point
 * of discovering from `state.vscdb`. The slug walk only runs for a session that has a
 * transcript but no header row, which is the one case left with nothing better to go on.
 */
export function resolveProjectPath(
  header: CursorComposerHeader | undefined,
  slug: string | undefined,
  activity: CursorConversationActivity | undefined,
  cache: Map<string, string | undefined>
): string | undefined {
  if (header?.projectPath) {
    return header.projectPath;
  }
  if (!slug) {
    return undefined;
  }
  return projectPathFromFiles(slug, activity?.files ?? []) ?? projectPathFromSlug(slug, cache);
}

/**
 * A single synthetic file operation carrying `composerHeaders`'s aggregate line counts.
 *
 * The database gives Cursor's own `totalLinesAdded`/`totalLinesRemoved` for the whole
 * conversation, not a per-file breakdown — there is no real path to attach them to file by
 * file. Rather than inventing per-file entries, one entry stands in for the session as a whole;
 * its `path` is the resolved project path when known (a real, verified directory) or a
 * synthetic id-keyed marker when not, purely because the aggregator drops any file operation
 * with no `path` at all. `filesChangedCount` itself rides separately on `metrics` — see
 * `ParsedSession.metrics.filesChangedCount` — because the aggregator's default files-changed
 * count (distinct operation paths) cannot represent an aggregate with only one synthetic entry.
 */
export function aggregateLinesFileOp(
  header: CursorComposerHeader | undefined,
  projectPath: string | undefined,
  sessionId: string
): NonNullable<ParsedSession['metrics']>['fileOperations'] {
  if (header?.linesAdded === undefined && header?.linesRemoved === undefined) {
    return [];
  }
  return [
    {
      type: 'edit',
      path: projectPath ?? `cursor-session:${sessionId}`,
      linesAdded: header.linesAdded ?? 0,
      linesRemoved: header.linesRemoved ?? 0,
    },
  ];
}

/**
 * Usage provenance for a session, from its `cursorDiskKV` bubbles.
 *
 * Cursor's per-turn token counts are sparse (~1% of bubbles) and have no
 * alignment to transcript messages, so there is nothing for a per-message reader to walk —
 * unlike a fabricated confident zero, `usagePartial: true` tells the report this total
 * understates the session's real usage. A session with no token signal anywhere keeps the
 * existing "unmeasurable" reason instead of a $0.00 that would read as "this was free".
 *
 * The summed tokens are attributed to the conversation's own recorded model (from the
 * AI-tracking database — the same single-value case `applyModels` already prefers) when
 * unambiguous, or `'unknown'` when no single model is recorded; an unrecognized model name
 * simply prices as unpriced rather than misattributing spend to the wrong model.
 */
export function resolveUsageMeta(
  bubbles: CursorBubbleSummary,
  activity: CursorConversationActivity | undefined
): NonNullable<ParsedSession['usageMeta']> {
  if (!bubbles.hasTokenSignal) {
    return { usageUnavailableReason: NO_USAGE_REASON };
  }
  const model = activity?.models[0] ?? 'unknown';
  return {
    usagePartial: true,
    tokensByModel: {
      [model]: { inputTokens: bubbles.totalInputTokens, outputTokens: bubbles.totalOutputTokens },
    },
  };
}
