/**
 * Tolerant reader for a Cursor agent transcript (`<conversation-id>.jsonl`).
 *
 * The format is thin and undocumented: each line is either a role-tagged message
 * (`{role, message: {content: [...]}}`) or a turn marker (`{type: 'turn_ended', status}`).
 * There are no timestamps, no model, no tokens and no tool results — everything else the
 * report shows comes from `cursor.tracking-db.ts`.
 *
 * A live session's final line can be truncated mid-write, so unparseable lines are dropped
 * rather than thrown: one bad line must not discard a whole session.
 */

import { readFileSync } from 'fs';
import { logger } from '../../../utils/logger.js';

/** A `tool_use` block inside an assistant message. */
export interface CursorToolUseBlock {
  type: 'tool_use';
  name?: string;
  input?: Record<string, unknown>;
}

/** A plain text block inside a message. */
export interface CursorTextBlock {
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
export interface CursorMarkerLine {
  type: string;
  status?: string;
}

export type CursorTranscriptLine = CursorMessageLine | CursorMarkerLine;

export function isMessageLine(line: CursorTranscriptLine): line is CursorMessageLine {
  return typeof (line as CursorMessageLine).role === 'string';
}

export function isMarkerLine(line: CursorTranscriptLine): line is CursorMarkerLine {
  return !isMessageLine(line) && typeof (line as CursorMarkerLine).type === 'string';
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
