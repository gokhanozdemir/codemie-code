/**
 * Transcript-to-native-message translation for the Cursor adapter.
 *
 * Messages are emitted in the Claude-shaped `{type, message: {role, content}}` form (with
 * `gitBranch` stamped alongside `message` — see {@link applyBranch}) on purpose:
 * `synthesizeRawSession` in `src/cli/commands/analytics/native-loader.ts` uses that shape for
 * its default branch, so Cursor needs no per-agent case there.
 */

import type { ParsedSession } from '../../core/session/BaseSessionAdapter.js';
import type { CursorConversationActivity } from './cursor.tracking-db.js';
import type { CursorMessageLine, CursorTranscriptLine } from './cursor.transcript.js';
import { contentBlocks, isMessageLine, userQueryText } from './cursor.transcript.js';

/** The Claude-shaped message the native loader's default synthesis branch understands. */
export interface CursorNativeMessage {
  type: 'user' | 'assistant';
  message: { role: 'user' | 'assistant'; content: string; model?: string };
  /** Top-level, sibling to `message` — where `synthesizeRawSession` reads `m.gitBranch` from. */
  gitBranch?: string;
}

/**
 * Stamp recorded models onto assistant messages — the only place the native loader looks for a
 * session's model distribution.
 *
 * The tracking database attributes a model to a conversation, not to a turn. When it recorded a
 * single model the whole conversation demonstrably ran on it, so every assistant message
 * carries it. When it recorded several, the per-turn split is unknown, so each model is counted
 * once instead of being spread into a distribution Cursor never stated. When it recorded none —
 * including a conversation whose only model was the literal `default`, which the reader drops —
 * nothing is stamped and the report shows the model as unknown.
 */
export function applyModels(messages: CursorNativeMessage[], models: string[]): void {
  if (models.length === 0) {
    return;
  }
  const assistant = messages.filter((message) => message.type === 'assistant');
  if (models.length === 1) {
    for (const message of assistant) {
      message.message.model = models[0];
    }
    return;
  }
  models.slice(0, assistant.length).forEach((model, i) => {
    assistant[i].message.model = model;
  });
}

/**
 * Stamp the header's real git branch onto every message — the only place the native loader's
 * default synthesis looks (`messages.map((m) => m.gitBranch)`, mode-voted). One branch per
 * conversation is all `composerHeaders` ever records, so every message carries the same value;
 * unlike {@link applyModels} there is no multi-value case to spread across turns.
 */
export function applyBranch(messages: CursorNativeMessage[], branch: string | undefined): void {
  if (!branch) {
    return;
  }
  for (const message of messages) {
    message.gitBranch = branch;
  }
}

/** What one transcript's lines amount to, once the shape Cursor writes is set aside. */
interface FlattenedTranscript {
  messages: CursorNativeMessage[];
  userPrompts: Array<{ count: number; text: string }>;
  tools: Record<string, number>;
}

/** The text of one line's content blocks, counting any tool_use it names along the way. */
function textOfLine(line: CursorMessageLine, tools: Record<string, number>): string {
  const texts: string[] = [];
  for (const block of contentBlocks(line)) {
    if (block.type === 'tool_use') {
      const name = (block as { name?: string }).name;
      if (name) {
        tools[name] = (tools[name] ?? 0) + 1;
      }
      continue;
    }
    const text = (block as { text?: string }).text;
    if (typeof text === 'string' && text.trim()) {
      texts.push(text);
    }
  }
  return texts.join('\n');
}

/**
 * Transcript lines as the message stream the native loader understands.
 *
 * Turn markers are skipped: they carry no fact the message stream does not already imply, since
 * the loader derives the turn count from assistant messages.
 */
export function flattenTranscript(lines: CursorTranscriptLine[]): FlattenedTranscript {
  const messages: CursorNativeMessage[] = [];
  const userPrompts: Array<{ count: number; text: string }> = [];
  const tools: Record<string, number> = {};

  for (const line of lines) {
    if (!isMessageLine(line)) {
      continue;
    }
    const role = line.role === 'assistant' ? 'assistant' : line.role === 'user' ? 'user' : undefined;
    if (!role) {
      continue;
    }

    const joined = textOfLine(line, tools);
    // Cursor wraps a prompt in <timestamp>/<user_query>; unwrap it so the report's session
    // title reads as the user's question rather than as a date.
    const content = role === 'user' ? (userQueryText(joined) ?? joined) : joined;
    if (!content.trim()) {
      continue;
    }

    messages.push({ type: role, message: { role, content } });
    if (role === 'user') {
      userPrompts.push({ count: 1, text: content });
    }
  }

  return { messages, userPrompts, tools };
}

/**
 * Files the agent wrote, as file operations.
 *
 * Line counts are deliberately absent: Cursor records content hashes, not diffs, so an added or
 * removed line count would have to be invented. `edit` rather than `write` because the database
 * does not distinguish creating a file from changing one.
 */
export function fileOperationsFrom(
  activity: CursorConversationActivity | undefined
): NonNullable<ParsedSession['metrics']>['fileOperations'] {
  return (activity?.files ?? []).map((path) => ({ type: 'edit', path }));
}
