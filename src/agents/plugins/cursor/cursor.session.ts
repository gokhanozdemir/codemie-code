/**
 * Cursor session adapter — analytics-only.
 *
 * Discovery is keyed on `composerId`, the identifier Cursor uses for one agent conversation
 * across every local store it writes: `state.vscdb`'s `composerHeaders` table (primary — see
 * `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`), the
 * `~/.cursor/projects/<project-slug>/agent-transcripts/<composerId>/<composerId>.jsonl`
 * transcript (secondary, joined by the shared id), and `ai_code_hashes.conversationId` in the
 * AI-tracking database (enrichment, same join). A session can have a header with no transcript
 * (most of them — transcripts cover a small fraction of real sessions), a transcript with no
 * header (observed rarely — schema drift, a header row Cursor pruned), or both; discovery
 * unions the two id sets rather than requiring either alone.
 *
 * `composerHeaders` is what makes project path, branch and line counts trustworthy:
 * `workspaceIdentifier.uri.fsPath` names the project directly, `activeBranch.branchName` /
 * `createdOnBranch` name the real branch, and `totalLinesAdded` / `totalLinesRemoved` /
 * `filesChangedCount` are Cursor's own totals rather than something reconstructed from content
 * hashes. Only when a session has no header row (transcript-only) does the adapter fall back
 * to the slug-walk project-path guess this file used to rely on for every session — see
 * {@link projectPathFromSlug}.
 *
 * A transcript, when one exists, still supplies what neither store does: role-tagged text,
 * tool_use blocks, turn markers, and a human-readable stamp on each prompt. It carries no model
 * and no token counts. So:
 *
 * - the activity window prefers the header's own timestamps, then Cursor's recorded first/last
 *   edit, then the prompt stamps, and only then the transcript file's birthtime/mtime — file
 *   times measure when the file was touched, so a conversation resumed days later would
 *   otherwise report a span of days rather than of minutes;
 * - messages are emitted deliberately WITHOUT per-message timestamps, so the native loader
 *   falls back to the descriptor's window instead of a fabricated per-message clock;
 * - `usageMeta.usageUnavailableReason` is always set, which is what makes the report render
 *   tokens and cost as unmeasurable rather than as a confident zero.
 *
 * Model and edited-file lists still come from the AI-tracking database, joined by the same
 * `composerId`/`conversationId` — see {@link CursorSessionAdapter.setTrackingIndex}. When
 * either store is missing, locked, on a runtime without `node:sqlite`, or schema-drifted, the
 * join simply finds nothing and the session degrades to whatever the remaining sources supply.
 *
 * Messages are emitted in the Claude-shaped `{type, message: {role, content}}` form (with
 * `gitBranch` stamped alongside `message` — see {@link applyBranch}) on purpose:
 * `synthesizeRawSession` in `src/cli/commands/analytics/native-loader.ts` uses that shape for
 * its default branch, so Cursor needs no per-agent case there.
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
import type { CursorComposerHeader, CursorComposerIndex } from './cursor.state-db.js';
import { readCursorComposerIndex } from './cursor.state-db.js';
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
  if (cache?.has(slug)) {
    return cache.get(slug);
  }
  const matches = descendMatchingSlug(sep, slug.split('-'));
  if (matches.length > 1) {
    logger.debug(`[cursor-discovery] slug ${slug} matches ${matches.length} directories — reporting no project`);
  }
  const resolved = matches.length === 1 ? matches[0] : undefined;
  cache?.set(slug, resolved);
  return resolved;
}

/**
 * Every existing directory reachable by consuming a slug whole, stopping at two.
 *
 * A child matches when its own name, slugified, equals the tokens it would have to account for.
 * Recursion (rather than a single greedy pass) is what makes `foo-bar/baz` and `foo/bar-baz`
 * both reachable from `foo-bar-baz`.
 *
 * More than one branch can succeed, because `/`, `_` and `-` all slugify to `-`: with both
 * `~/work/my_app` and `~/work/my-app` on disk, one slug describes them equally well. Collecting
 * a second match is how the caller learns to stay silent — attributing a session confidently to
 * the wrong project is worse than reporting none. Two is enough to know it is ambiguous, and
 * stopping there keeps the walk from exploring a tree it has already disqualified.
 *
 * Terminating: every step consumes at least one token, so depth is bounded by the token count
 * even if a symlink points back up the tree.
 */
function descendMatchingSlug(dir: string, tokens: string[], found: string[] = []): string[] {
  if (tokens.length === 0) {
    found.push(dir);
    return found;
  }
  for (const name of readDirNames(dir)) {
    if (found.length >= 2) {
      break;
    }
    const nameTokens = slugForPath(name).split('-');
    if (nameTokens.length > tokens.length) {
      continue;
    }
    if (!nameTokens.every((token, i) => token === tokens[i])) {
      continue;
    }
    descendMatchingSlug(join(dir, name), tokens.slice(nameTokens.length), found);
  }
  return found;
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

/** The Claude-shaped message the native loader's default synthesis branch understands. */
interface CursorNativeMessage {
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

/**
 * Stamp the header's real git branch onto every message — the only place the native loader's
 * default synthesis looks (`messages.map((m) => m.gitBranch)`, mode-voted). One branch per
 * conversation is all `composerHeaders` ever records, so every message carries the same value;
 * unlike {@link applyModels} there is no multi-value case to spread across turns.
 */
function applyBranch(messages: CursorNativeMessage[], branch: string | undefined): void {
  if (!branch) {
    return;
  }
  for (const message of messages) {
    message.gitBranch = branch;
  }
}

/**
 * When a conversation ran, preferring `composerHeaders`'s own timestamps over anything derived.
 *
 * A header can record only one end of the window (Cursor's own writes are not guaranteed
 * complete either) — in that case the other end mirrors it rather than falling through to a
 * weaker source for half the answer and a stronger one for the other half.
 */
function resolveWindow(
  header: CursorComposerHeader | undefined,
  filePath: string,
  activity: CursorConversationActivity | undefined
): { createdAt: number; updatedAt: number } | undefined {
  if (header?.createdAt !== undefined || header?.updatedAt !== undefined) {
    const createdAt = header.createdAt ?? header.updatedAt!;
    const updatedAt = header.updatedAt ?? header.createdAt!;
    return { createdAt, updatedAt: Math.max(createdAt, updatedAt) };
  }
  return activityWindow(filePath, activity);
}

/**
 * The project path for a conversation: `composerHeaders`'s own `workspaceIdentifier.uri.fsPath`
 * when the session has a header, with no slug-guessing needed at all — that is the whole point
 * of discovering from `state.vscdb`. The slug walk only runs for a session that has a
 * transcript but no header row, which is the one case left with nothing better to go on.
 */
function resolveProjectPath(
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
function aggregateLinesFileOp(
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

/**
 * A stable, never-created path for a session discovered only through `composerHeaders` — no
 * transcript exists for it on disk. `parseSessionFile` takes its conversation id from the
 * path's own basename (`basename(filePath, '.jsonl')`), so this has to end in
 * `<composerId>.jsonl` for that id round-trip to work like it does for a real transcript path;
 * everything upstream of that (`readCursorTranscript`, `statSync` for the file-time fallback)
 * already degrades to "no data" for a path that does not exist, so nothing downstream needs to
 * know this path is synthetic.
 */
function virtualTranscriptPath(root: string, composerId: string): string {
  return join(root, '.composer-only', composerId, `${composerId}.jsonl`);
}

/** One discovered transcript: where it lives, and the project slug it lives under. */
interface DiscoveredTranscript {
  filePath: string;
  slug: string;
}

/**
 * Every real transcript under `~/.cursor/projects`, keyed by conversation id.
 *
 * `projects/` also holds directories that are not projects at all (numeric window ids,
 * `empty-window`) and project directories holding only `canvases`/`terminals`/`mcps`, so this
 * keys on the presence of `agent-transcripts` rather than on the directory name — same rule the
 * single-pass scan used before discovery split into "list transcripts" and "list headers".
 */
function findTranscripts(root: string): Map<string, DiscoveredTranscript> {
  const found = new Map<string, DiscoveredTranscript>();
  if (!existsSync(root)) {
    return found;
  }
  for (const slug of readDirNames(root)) {
    const transcriptsRoot = join(root, slug, TRANSCRIPTS_DIR);
    if (!existsSync(transcriptsRoot)) {
      continue;
    }
    for (const conversationId of readDirNames(transcriptsRoot)) {
      const filePath = join(transcriptsRoot, conversationId, `${conversationId}.jsonl`);
      if (existsSync(filePath)) {
        found.set(conversationId, { filePath, slug });
      }
    }
  }
  return found;
}

export class CursorSessionAdapter implements SessionAdapter {
  readonly agentName = CURSOR_AGENT_NAME;
  private processors: SessionProcessor[] = [];

  /**
   * Slug → project path, for this adapter's lifetime.
   *
   * Resolving a slug walks the filesystem from the root, and every conversation in a project
   * repeats the same slug — so without this a run pays for the walk once per session rather
   * than once per project. The adapter is memoized per run, which is exactly the scope the
   * answer is stable over.
   */
  private readonly slugPaths = new Map<string, string | undefined>();

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

  /**
   * Enrichment from `state.vscdb`'s `composerHeaders` table, keyed by composerId — the primary
   * session-discovery source (see the module doc comment). Memoized for the same reason as
   * {@link trackingIndexLoad}: one adapter instance per process, one database read per run.
   */
  private composerIndexLoad?: Promise<CursorComposerIndex>;

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

  /**
   * Attach the composer index directly — the `state.vscdb` counterpart of
   * {@link setTrackingIndex}, for the same reasons (async load, test injection).
   */
  setComposerIndex(index: CursorComposerIndex): void {
    this.composerIndexLoad = Promise.resolve(index);
  }

  /**
   * The composer index, reading `state.vscdb` on first use.
   *
   * `readCursorComposerIndex` never throws — see its own contract — so a missing, locked or
   * schema-drifted state database degrades discovery to transcript-only, not to zero sessions.
   */
  private async composerIndex(): Promise<CursorComposerIndex> {
    this.composerIndexLoad ??= readCursorComposerIndex();
    return this.composerIndexLoad;
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[cursor-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Enumerate every discoverable Cursor session, newest first.
   *
   * Session identity is the union of two id sets: every composerId `state.vscdb`'s
   * `composerHeaders` table has a (non-draft) row for, and every composerId with a real
   * transcript under `~/.cursor/projects`. Most real sessions today have a header and no
   * transcript; a small, shrinking set has a transcript with no header (schema drift, a pruned
   * row) and falls all the way back to the pre-ADR-0001 slug walk. Neither set alone is
   * discovery — see the module doc comment.
   *
   * Discovery deliberately does not open transcripts: a transcript file's own stat, or the
   * header's own timestamps, are enough to date and filter a session, so a run never pays to
   * read a transcript it goes on to discard.
   *
   * The descriptor — not the parsed session — is where enrichment has to land for timing and
   * project: Cursor messages carry no timestamps and no cwd, so the native loader's synthesis
   * falls back to `descriptor.createdAt` / `updatedAt` / `projectPath` for exactly those three
   * facts. Resolving the window here also keeps the age cutoff and the reported window
   * consistent with each other.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const root = getCursorProjectsRoot();
    const transcripts = findTranscripts(root);
    const [tracking, composerIndex] = await Promise.all([this.trackingIndex(), this.composerIndex()]);

    if (transcripts.size === 0 && composerIndex.size === 0) {
      logger.debug(`[cursor-discovery] no Cursor sessions found (no state database, no transcripts under ${root})`);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;

    const composerIds = new Set<string>([...transcripts.keys(), ...composerIndex.keys()]);
    const results: SessionDescriptor[] = [];

    for (const composerId of composerIds) {
      const descriptor = this.describeConversation(
        root,
        composerId,
        composerIndex.get(composerId),
        transcripts.get(composerId),
        tracking
      );
      if (!descriptor || descriptor.createdAt < cutoffMs) {
        continue;
      }
      if (options?.cwd && !sameDir(descriptor.projectPath, options.cwd)) {
        continue;
      }
      results.push(descriptor);
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
   * One conversation as a descriptor, or undefined when neither source can date it.
   *
   * The descriptor — not the parsed session — is where the project and the window have to land:
   * Cursor's messages carry no timestamps and no cwd, so the native loader's default synthesis
   * reads exactly those facts off the descriptor.
   */
  private describeConversation(
    root: string,
    composerId: string,
    header: CursorComposerHeader | undefined,
    transcript: DiscoveredTranscript | undefined,
    tracking: CursorTrackingIndex
  ): SessionDescriptor | undefined {
    const filePath = transcript?.filePath ?? virtualTranscriptPath(root, composerId);
    const activity = tracking.get(composerId);
    const window = resolveWindow(header, filePath, activity);
    if (!window) {
      return undefined;
    }

    return {
      sessionId: composerId,
      filePath,
      projectPath: resolveProjectPath(header, transcript?.slug, activity, this.slugPaths),
      createdAt: window.createdAt,
      updatedAt: window.updatedAt,
      agentName: this.agentName,
    };
  }

  /**
   * Parse one conversation.
   *
   * The conversation id is the file's own basename, which is also the key both the AI-tracking
   * database and the composer index join on, so no separate correlation step is needed. A
   * header-only session (see the module doc comment) has a synthetic, never-created `filePath`
   * — `readCursorTranscript` and the file-time fallbacks all already degrade to "no data" for a
   * path that does not exist, so nothing here needs a separate code path for that case except
   * the slug walk, which has no slug to walk without a real transcript.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    const conversationId = basename(filePath, '.jsonl');
    const hasTranscript = existsSync(filePath);
    const lines = hasTranscript ? readCursorTranscript(filePath) : [];
    const [activity, composerIndex] = await Promise.all([
      this.trackingIndex().then((index) => index.get(conversationId)),
      this.composerIndex(),
    ]);
    const header = composerIndex.get(conversationId);

    const { messages, userPrompts, tools } = flattenTranscript(lines);

    applyModels(messages, activity?.models ?? []);
    applyBranch(messages, header?.branch);

    const window = resolveWindow(header, filePath, activity);
    const slug = hasTranscript ? slugOfTranscript(filePath) : undefined;
    const projectPath = resolveProjectPath(header, slug, activity, this.slugPaths);

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
        branch: header?.branch,
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
        fileOperations: [
          ...(fileOperationsFrom(activity) ?? []),
          ...(aggregateLinesFileOp(header, projectPath, sessionId) ?? []),
        ],
        filesChangedCount: header?.filesChangedCount,
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
