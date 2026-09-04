/**
 * Tolerant reader for a Cursor agent transcript (`<conversation-id>.jsonl`).
 *
 * The format is thin and undocumented: each line is either a role-tagged message
 * (`{role, message: {content: [...]}}`) or a turn marker (`{type: 'turn_ended', status}`).
 * There is no model, no token count and no tool result — those come from
 * `cursor.tracking-db.ts`. The one timing signal a transcript does carry is the human-readable
 * `<timestamp>` Cursor writes ahead of every prompt; see {@link transcriptStampWindow}.
 *
 * A live session's final line can be truncated mid-write, so unparseable lines are dropped
 * rather than thrown: one bad line must not discard a whole session.
 */

import { readFileSync } from 'fs';
import { logger } from '../../../utils/logger.js';

/** A `tool_use` block inside an assistant message. */
interface CursorToolUseBlock {
  type: 'tool_use';
  name?: string;
  input?: Record<string, unknown>;
}

/** A plain text block inside a message. */
interface CursorTextBlock {
  type: 'text';
  text?: string;
}

export type CursorContentBlock = CursorToolUseBlock | CursorTextBlock | { type?: string };

/** A role-tagged transcript line. */
export interface CursorMessageLine {
  role: 'user' | 'assistant' | string;
  message?: { content?: CursorContentBlock[] | string };
}

/** A control line, e.g. `{"type":"turn_ended","status":"success"}`. */
interface CursorMarkerLine {
  type: string;
  status?: string;
}

export type CursorTranscriptLine = CursorMessageLine | CursorMarkerLine;

export function isMessageLine(line: CursorTranscriptLine): line is CursorMessageLine {
  return typeof (line as CursorMessageLine).role === 'string';
}

/** The content blocks of a message, normalized to an array (a bare string becomes one text block). */
export function contentBlocks(line: CursorMessageLine): CursorContentBlock[] {
  const content = line.message?.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}

/** Read a transcript, dropping any line that is not parseable JSON. Never throws. */
export function readCursorTranscript(filePath: string): CursorTranscriptLine[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.debug(`[cursor] unreadable transcript at ${filePath}:`, error);
    return [];
  }

  const lines: CursorTranscriptLine[] = [];
  let dropped = 0;

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        lines.push(parsed as CursorTranscriptLine);
      }
    } catch {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.debug(`[cursor] dropped ${dropped} unparseable line(s) in ${filePath}`);
  }
  return lines;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The stamp Cursor writes ahead of every prompt, e.g.
 * `<timestamp>Monday, Aug 31, 2026, 5:46 PM (UTC+3)</timestamp>`. The weekday is ignored — it
 * carries no information the date does not — and the explicit offset is what makes the instant
 * unambiguous. The `<timestamp>` wrapper is part of the pattern on purpose: a bare date shape
 * also occurs in pasted logs and model output, and matching those would date the session by
 * whatever text it happened to quote.
 */
const STAMP_PATTERN =
  /<timestamp>[^<]*?([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})(?::(\d{2}))?\)[^<]*?<\/timestamp>/gi;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** One Cursor stamp as epoch ms, or undefined when it is not a shape we recognise. */
function stampToEpochMs(match: RegExpExecArray): number | undefined {
  const [, month, day, year, hour12, minute, meridiem, offsetHours, offsetMinutes] = match;
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex < 0) {
    return undefined;
  }
  const hour = Number(hour12) % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
  const offsetSign = offsetHours.startsWith('-') ? '-' : '+';
  const offset = `${offsetSign}${pad(Math.abs(Number(offsetHours)))}:${pad(Number(offsetMinutes ?? 0))}`;
  const parsed = Date.parse(
    `${year}-${pad(monthIndex + 1)}-${pad(Number(day))}T${pad(hour)}:${pad(Number(minute))}:00${offset}`
  );
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * When the conversation actually ran, from the stamps Cursor writes into the prompts.
 *
 * This is the only in-transcript timing signal, and for a conversation the AI-tracking database
 * never recorded an edit for it is the only honest one available. The alternative — the
 * transcript file's birthtime and mtime — measures when the file was touched, not when the work
 * happened, so a conversation resumed days later reports a span of days instead of of minutes.
 *
 * Scans the raw text rather than the parsed lines: this runs during discovery, for sessions that
 * may yet be filtered out, so it must not pay for JSON parsing. Undefined when nothing is
 * stamped, which is the caller's cue to fall back to file times.
 */
export function transcriptStampWindow(filePath: string): { firstMs: number; lastMs: number } | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.debug(`[cursor] unreadable transcript at ${filePath}:`, error);
    return undefined;
  }

  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const match of text.matchAll(STAMP_PATTERN)) {
    const ms = stampToEpochMs(match);
    if (ms === undefined) {
      continue;
    }
    firstMs = firstMs === undefined || ms < firstMs ? ms : firstMs;
    lastMs = lastMs === undefined || ms > lastMs ? ms : lastMs;
  }

  return firstMs === undefined || lastMs === undefined ? undefined : { firstMs, lastMs };
}

/**
 * The user's own words in a Cursor user message.
 *
 * Cursor wraps every prompt in `<timestamp>…</timestamp>` and `<user_query>…</user_query>`.
 * Returning the raw text would make the report's session title read as a date, so the query
 * is unwrapped here. Text with no `<user_query>` is an injected continuation prompt
 * (subagent hand-offs, "briefly inform the user…") rather than something the user typed.
 */
export function userQueryText(text: string): string | undefined {
  const match = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);
  const query = match?.[1]?.trim();
  return query ? query : undefined;
}
