/**
 * Cursor session adapter — analytics-only.
 *
 * Discovery is keyed on `composerId`, the identifier Cursor uses for one agent conversation
 * across every local store it writes: `state.vscdb`'s `composerHeaders` table (primary;
 * undocumented VS Code/Cursor state, fail-soft), the
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
 * - `usageMeta.usageUnavailableReason` is set only when `cursorDiskKV`'s bubbles carried no
 *   token signal at all for the session — see {@link resolveUsageMeta} — which is what makes
 *   the report render tokens and cost as unmeasurable rather than as a confident zero for the
 *   (large) majority of sessions the sparse per-turn token data never touches.
 *
 * Model and edited-file lists still come from the AI-tracking database, joined by the same
 * `composerId`/`conversationId` — see {@link CursorSessionAdapter.setTrackingIndex}. Per-tool
 * call outcomes (success/failure) and partial token pricing come from `state.vscdb`'s
 * `cursorDiskKV` table (`bubbleId:<composerId>:<bubbleId>` rows), joined the same way — see
 * `cursor.bubbles.ts`. When any of these stores is missing, locked, on a runtime without
 * `node:sqlite`, or schema-drifted, the join simply finds nothing and the session degrades to
 * whatever the remaining sources supply.
 *
 * Messages are emitted in the Claude-shaped `{type, message: {role, content}}` form (with
 * `gitBranch` stamped alongside `message` — see {@link applyBranch}) on purpose:
 * `synthesizeRawSession` in `src/cli/commands/analytics/native-loader.ts` uses that shape for
 * its default branch, so Cursor needs no per-agent case there.
 *
 * Everything is read-only and fail-soft. A missing Cursor home yields zero sessions, never an
 * error — analytics for every other agent must survive Cursor not being installed.
 */

import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
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
import type { CursorTrackingIndex } from './cursor.tracking-db.js';
import { readCursorTrackingIndex } from './cursor.tracking-db.js';
import type { CursorComposerHeader, CursorComposerIndex } from './cursor.state-db.js';
import { readCursorComposerIndex } from './cursor.state-db.js';
import { readCursorBubbles } from './cursor.bubbles.js';
import { readCursorTranscript } from './cursor.transcript.js';
import { sameDir, readDirNames } from './cursor.project-path.js';
import { applyModels, applyBranch, flattenTranscript, fileOperationsFrom } from './cursor.native-messages.js';
import { resolveWindow, resolveProjectPath, aggregateLinesFileOp, resolveUsageMeta } from './cursor.session-meta.js';
import { logger } from '@/utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Subdirectory of a Cursor project directory that holds agent conversations. */
const TRANSCRIPTS_DIR = 'agent-transcripts';

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
   * row) and falls all the way back to the slug-walk project-path guess. Neither set alone is
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
    const [activity, composerIndex, bubbles] = await Promise.all([
      this.trackingIndex().then((index) => index.get(conversationId)),
      this.composerIndex(),
      readCursorBubbles(conversationId),
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
      usageMeta: resolveUsageMeta(bubbles, activity),
      metrics: {
        tools,
        // Real per-tool success/failure, from cursorDiskKV's toolFormerData.status — replaces
        // the old assumed-success behavior (a tool named in `tools` but absent here just means
        // no bubble resolved an outcome for it, e.g. a call still 'loading' when scanned).
        // Populated independent of `hasTranscript`: bubbles are keyed by composerId directly,
        // so a header-only session (most of them) gets real tool outcomes too.
        ...(Object.keys(bubbles.toolStatus).length > 0 && { toolStatus: bubbles.toolStatus }),
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
