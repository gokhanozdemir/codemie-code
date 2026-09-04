/**
 * Cursor session adapter — analytics-only.
 *
 * Cursor keeps one transcript per agent conversation at
 * `~/.cursor/projects/<project-slug>/agent-transcripts/<conversation-id>/<conversation-id>.jsonl`.
 * `projects/` also holds directories that are not projects at all (numeric window ids,
 * `empty-window`) and project directories holding only `canvases`/`terminals`/`mcps`, so
 * discovery keys on the presence of `agent-transcripts` rather than on the directory name.
 *
 * What a transcript can and cannot tell us is the whole design constraint here. It carries
 * role-tagged text, tool_use blocks, turn markers, and a human-readable stamp on each prompt —
 * but no model and no token counts. So:
 *
 * - the activity window comes from Cursor's own first/last recorded edit, falling back to the
 *   prompt stamps, and only then to the transcript file's birthtime/mtime — file times measure
 *   when the file was touched, so a conversation resumed days later would otherwise report a
 *   span of days rather than of minutes;
 * - messages are emitted deliberately WITHOUT timestamps, so the native loader falls back to
 *   the descriptor's window instead of a fabricated per-message clock;
 * - `usageMeta.usageUnavailableReason` is always set, which is what makes the report render
 *   tokens and cost as unmeasurable rather than as a confident zero.
 *
 * Model, precise edit times, edited-file lists and the only trustworthy project path live in
 * Cursor's AI-tracking database. The adapter reads it once per run and joins on conversation
 * id — see {@link CursorSessionAdapter.setTrackingIndex}. When it is missing, locked, on a
 * runtime without `node:sqlite` or schema-drifted, the join simply finds nothing and every
 * session degrades to its transcript-only form.
 *
 * Messages are emitted in the Claude-shaped `{type, message: {role, content}}` form on
 * purpose: `synthesizeRawSession` in `src/cli/commands/analytics/native-loader.ts` uses that
 * shape for its default branch, so Cursor needs no per-agent case there.
 *
 * Everything is read-only and fail-soft. A missing Cursor home yields zero sessions, never an
 * error — analytics for every other agent must survive Cursor not being installed.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, sep } from 'path';
import type {
  SessionAdapter,
  ParsedSession,
  AggregatedResult,
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/BaseSessionAdapter.js';
import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { CURSOR_AGENT_NAME } from './cursor.constants.js';
import { getCursorProjectsRoot } from './cursor.paths.js';
import type { CursorConversationActivity, CursorTrackingIndex } from './cursor.tracking-db.js';
import { readCursorTrackingIndex } from './cursor.tracking-db.js';
import type { CursorMessageLine, CursorTranscriptLine } from './cursor.transcript.js';
import {
  contentBlocks,
  isMessageLine,
  readCursorTranscript,
  transcriptStampWindow,
  userQueryText,
} from './cursor.transcript.js';
import { logger } from '../../../utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Subdirectory of a Cursor project directory that holds agent conversations. */
const TRANSCRIPTS_DIR = 'agent-transcripts';

/**
 * Why a Cursor session is never priced.
 *
 * Cursor stores no token counts anywhere on disk — not in the transcript, not in the
 * AI-tracking database. Reporting zero cost would read as "this session was free"; the
 * reason string makes the report say "unmeasurable" instead.
 */
const NO_USAGE_REASON =
  'Cursor records no token usage locally — its transcripts carry no token counts, so cost cannot be derived';

/** Trailing-separator-insensitive directory comparison. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '');
}

/**
 * Best-effort project path for a Cursor project slug.
 *
 * The slug is lossy in two directions at once: Cursor replaces `/` and `_` alike with `-`, and
 * a directory name may contain `-` of its own. So a `-` in a slug can mean any of three things,
 * and splitting on it cannot work — `Users-ada_lovelace-claude-code-router` would de-slug to
 * `/Users/ada/lovelace/claude/code/router`, which is nobody's project. That naive reversal is
 * why nearly every session used to report no project at all.
 *
 * Instead of guessing at the string, this walks the filesystem and lets it decide: from the
 * root, only descend into a child whose own slug matches the next tokens of the slug being
 * resolved. Each step is verified against a directory that exists, so the result is Cursor's
 * own naming confirmed rather than a plausible-looking reconstruction — the same principle
 * {@link projectPathFromFiles} already applies to the tracking database's file paths. When no
 * branch consumes the whole slug the session stays silent about its project: an honest gap
 * still beats a wrong answer.
 */
function projectPathFromSlug(slug: string, cache?: Map<string, string | undefined>): string | undefined {
  const cached = cache?.get(slug);
  if (cached !== undefined || cache?.has(slug)) {
    return cached;
  }
  const resolved = descendMatchingSlug(sep, slug.split('-'));
  cache?.set(slug, resolved);
  return resolved;
}

/**
 * Deepest existing directory reached by consuming every token of a slug.
 *
 * A child matches when its own name, slugified, equals the tokens it would have to account
 * for. Recursion (rather than a single greedy pass) is what makes `foo-bar/baz` and
 * `foo/bar-baz` both reachable from `foo-bar-baz`; the first branch that consumes the slug
 * whole wins, and there is only ever one such branch on a real filesystem.
 */
function descendMatchingSlug(dir: string, tokens: string[]): string | undefined {
  if (tokens.length === 0) {
    return dir;
  }
  for (const name of readDirNames(dir)) {
    const nameTokens = slugForPath(name).split('-');
    if (nameTokens.length > tokens.length) {
      continue;
    }
    if (!nameTokens.every((token, i) => token === tokens[i])) {
      continue;
    }
    const found = descendMatchingSlug(join(dir, name), tokens.slice(nameTokens.length));
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** The slug Cursor would have written for a directory: leading separator dropped, `/` and `_` → `-`. */
function slugForPath(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\_]/g, '-');
}

/** Deepest directory that is an ancestor of (or equal to) both paths. */
function commonAncestor(a: string, b: string): string {
  const left = a.split(sep);
  const right = b.split(sep);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) {
    shared.push(left[i]);
  }
  return shared.join(sep) || sep;
}

/**
 * Project root for a conversation, recovered from the absolute paths the AI-tracking database
 * recorded for it.
 *
 * The slug alone cannot be reversed (see {@link projectPathFromSlug}), and the files' common
 * directory alone is not the project root either — a conversation that only touched `src/`
 * yields `<root>/src`. Combining the two settles it: walk up from the common directory until a
 * directory slugifies back to the slug Cursor filed the conversation under. That match is a
 * verification against Cursor's own naming, not a guess, so the answer is exact even for slugs
 * whose `-` came from a `_`. No match means we stay silent and let the caller fall back.
 */
function projectPathFromFiles(slug: string, files: string[]): string | undefined {
  const absolute = files.filter((file) => isAbsolute(file));
  if (absolute.length === 0) {
    return undefined;
  }

  let dir = absolute.map(dirname).reduce(commonAncestor);
  for (;;) {
    if (slugForPath(dir) === slug) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Subdirectory names of `dir`, or an empty list when it cannot be read.
 *
 * Symlinked directories count. On macOS `/var` — the ancestor of every temporary directory, and
 * of plenty of real project trees — is a symlink, and `isDirectory()` is false for a symlink, so
 * filtering on it alone would make the slug walk give up at the first step.
 */
function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))))
      .map((entry) => entry.name);
  } catch (error) {
    logger.debug(`[cursor-discovery] failed to read ${dir}:`, error);
    return [];
  }
}

/** Whether `path` is a directory, following symlinks. False when it cannot be stat'd. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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
  const stamps = activity?.firstEditMs === undefined ? transcriptStampWindow(filePath) : undefined;
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

/** The Claude-shaped message the native loader's default synthesis branch understands. */
interface CursorNativeMessage {
  type: 'user' | 'assistant';
  message: { role: 'user' | 'assistant'; content: string; model?: string };
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
function applyModels(messages: CursorNativeMessage[], models: string[]): void {
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
function flattenTranscript(lines: CursorTranscriptLine[]): FlattenedTranscript {
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
function fileOperationsFrom(activity: CursorConversationActivity | undefined): NonNullable<ParsedSession['metrics']>['fileOperations'] {
  return (activity?.files ?? []).map((path) => ({ type: 'edit', path }));
}

/**
 * The project slug a transcript lives under, given the fixed layout
 * `<projects>/<slug>/agent-transcripts/<conversation-id>/<conversation-id>.jsonl`.
 */
function slugOfTranscript(filePath: string): string {
  return basename(dirname(dirname(dirname(filePath))));
}

export class CursorSessionAdapter implements SessionAdapter {
  readonly agentName = CURSOR_AGENT_NAME;
  private processors: SessionProcessor[] = [];

  /**
   * Enrichment from `~/.cursor/ai-tracking/ai-code-tracking.db`, keyed by conversation id.
   *
   * Memoized as the in-flight promise rather than the resolved map so that discovery and every
   * subsequent parse share a single database read: the plugin hands out one adapter instance
   * per process (`CursorPlugin.getSessionAdapter`), and an analytics run discovers once and
   * then parses each transcript, so one memo here is one read per run. Doing it inside the
   * adapter — rather than making the native loader call `readCursorTrackingIndex` before
   * dispatching — keeps `native-loader.ts` free of Cursor-specific code, which is the whole
   * reason the Cursor adapter emits Claude-shaped output in the first place.
   */
  private trackingIndexLoad?: Promise<CursorTrackingIndex>;

  constructor(private readonly metadata: AgentMetadata) {}

  /**
   * Attach the AI-tracking index that supplies what a transcript cannot: the model, the edited
   * files and the real edit window.
   *
   * The injection seam exists because loading the database is async, needs Node >= 22.5 and
   * must happen once per run; tests and any future caller that already holds an index can hand
   * it over and suppress the lazy read below.
   */
  setTrackingIndex(index: CursorTrackingIndex): void {
    this.trackingIndexLoad = Promise.resolve(index);
  }

  /**
   * The tracking index, reading the database on first use.
   *
   * `readCursorTrackingIndex` never throws — a missing, locked or schema-drifted database
   * resolves to an empty map — so no failure here can cost the run its transcript-only rows.
   */
  private async trackingIndex(): Promise<CursorTrackingIndex> {
    this.trackingIndexLoad ??= readCursorTrackingIndex();
    return this.trackingIndexLoad;
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[cursor-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Enumerate every agent transcript under `~/.cursor/projects`, newest first.
   *
   * Discovery deliberately does not open transcripts: the file's own stat is enough to date
   * and filter a session, so a run never pays to read a transcript it goes on to discard.
   *
   * The descriptor — not the parsed session — is where enrichment has to land for timing and
   * project: Cursor messages carry no timestamps and no cwd, so the native loader's synthesis
   * falls back to `descriptor.createdAt` / `updatedAt` / `projectPath` for exactly those three
   * facts. Applying the tracking window here also keeps the age cutoff and the reported window
   * consistent with each other.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const root = getCursorProjectsRoot();
    if (!existsSync(root)) {
      logger.debug(`[cursor-discovery] no Cursor projects directory at ${root}`);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
    const tracking = await this.trackingIndex();

    const results: SessionDescriptor[] = [];
    // Resolving a slug walks the filesystem, and every conversation in a project repeats the
    // same slug, so the answer is worked out once per project per run.
    const slugPaths = new Map<string, string | undefined>();

    for (const slug of readDirNames(root)) {
      const transcriptsRoot = join(root, slug, TRANSCRIPTS_DIR);
      if (!existsSync(transcriptsRoot)) {
        continue;
      }

      for (const conversationId of readDirNames(transcriptsRoot)) {
        const descriptor = this.describeConversation(transcriptsRoot, conversationId, slug, tracking, slugPaths);
        if (!descriptor || descriptor.createdAt < cutoffMs) {
          continue;
        }
        if (options?.cwd && !sameDir(descriptor.projectPath, options.cwd)) {
          continue;
        }
        results.push(descriptor);
      }
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (options?.limit && options.limit > 0) {
      logger.debug(`[cursor-discovery] found ${results.length} session(s), returning ${options.limit}`);
      return results.slice(0, options.limit);
    }

    logger.debug(`[cursor-discovery] found ${results.length} session(s)`);
    return results;
  }

  /**
   * One conversation as a descriptor, or undefined when it has no transcript on disk.
   *
   * The descriptor — not the parsed session — is where the project and the window have to land:
   * Cursor's messages carry no timestamps and no cwd, so the native loader's default synthesis
   * reads exactly those facts off the descriptor.
   */
  private describeConversation(
    transcriptsRoot: string,
    conversationId: string,
    slug: string,
    tracking: CursorTrackingIndex,
    slugPaths: Map<string, string | undefined>
  ): SessionDescriptor | undefined {
    const filePath = join(transcriptsRoot, conversationId, `${conversationId}.jsonl`);
    if (!existsSync(filePath)) {
      return undefined;
    }

    // A conversation that exists only in the database has no transcript and never reaches this
    // point — the transcript file is the sole source of session identity.
    const activity = tracking.get(conversationId);
    const window = activityWindow(filePath, activity);
    if (!window) {
      return undefined;
    }

    return {
      sessionId: conversationId,
      filePath,
      projectPath:
        projectPathFromFiles(slug, activity?.files ?? []) ?? projectPathFromSlug(slug, slugPaths),
      createdAt: window.createdAt,
      updatedAt: window.updatedAt,
      agentName: this.agentName,
    };
  }

  /**
   * Parse one conversation transcript.
   *
   * The conversation id is the file's own basename, which is also the key the AI-tracking
   * database joins on, so no separate correlation step is needed.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    const conversationId = basename(filePath, '.jsonl');
    const lines = readCursorTranscript(filePath);
    const activity = (await this.trackingIndex()).get(conversationId);

    const { messages, userPrompts, tools } = flattenTranscript(lines);

    applyModels(messages, activity?.models ?? []);

    const window = activityWindow(filePath, activity);
    const slug = slugOfTranscript(filePath);
    const projectPath = projectPathFromFiles(slug, activity?.files ?? []) ?? projectPathFromSlug(slug);

    logger.debug(
      `[cursor-adapter] ${conversationId}: ${messages.length} message(s), ${userPrompts.length} prompt(s)`
    );

    return {
      sessionId,
      agentName: this.metadata.displayName,
      metadata: {
        projectPath,
        createdAt: window === undefined ? undefined : new Date(window.createdAt).toISOString(),
        updatedAt: window === undefined ? undefined : new Date(window.updatedAt).toISOString(),
      },
      // No per-message timestamps exist, and inventing them would make the report show a
      // duration Cursor never recorded. Leaving them out makes the loader fall back to the
      // descriptor's file-derived window, which is the only real signal available.
      messages,
      usageMeta: {
        usageUnavailableReason: NO_USAGE_REASON,
      },
      metrics: {
        tools,
        userPrompts,
        fileOperations: fileOperationsFrom(activity),
      },
    };
  }

  /** Parse once, then run every registered processor in priority order. */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    const parsed = await this.parseSessionFile(filePath, sessionId);

    const processors: AggregatedResult['processors'] = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      if (!processor.shouldProcess(parsed)) {
        continue;
      }
      try {
        const result: ProcessingResult = await processor.process(parsed, context);
        const recordsProcessed = result.metadata?.recordsProcessed ?? 0;
        totalRecords += recordsProcessed;
        processors[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed,
        };
        if (!result.success) {
          failedProcessors.push(processor.name);
        }
      } catch (error) {
        logger.error(`[cursor-adapter] Processor ${processor.name} failed:`, error);
        processors[processor.name] = {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
        failedProcessors.push(processor.name);
      }
    }

    return {
      success: failedProcessors.length === 0,
      processors,
      totalRecords,
      failedProcessors,
    };
  }
}
