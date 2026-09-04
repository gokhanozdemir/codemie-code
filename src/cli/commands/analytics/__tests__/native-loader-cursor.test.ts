/**
 * Cursor analytics, driven from the outside.
 *
 * Cursor is CodeMie's first analytics-only agent: never installed, never launched, only read.
 * These tests exercise the whole ingestion path from the top seam — `loadNativeSessions()` —
 * against a fixture Cursor home reached through the `CURSOR_HOME` override, exactly the way
 * `copilot-cli.discovery.test.ts` drives `COPILOT_HOME`. Nothing here reaches into a parser:
 * a Cursor home goes in, analytics rows come out, and the assertions are about those rows.
 *
 * Discovery and parsing run through the real registry-resolved `CursorSessionAdapter`; the
 * loader's other dependencies (tracked-log dedup, ownership markers, the other native agents)
 * are injected, which is what keeps the run off `~/.codemie` and off the developer's own
 * `~/.cursor`. Each run re-imports the module graph so the adapter's once-per-run tracking-index
 * memo cannot leak one test's fixture database into the next.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeLoaderDeps, DiscoveredNative } from '../native-loader.js';
import type { RawSessionData } from '../data-loader.js';
import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';

/**
 * `node:sqlite` landed in Node 22.5 and the repo supports Node >= 20, so the tracking-database
 * enrichment is optional at runtime — and the tests that need a fixture database are optional
 * too. On an older runtime they skip and the transcript-only expectations below still run,
 * which is the same degradation the product promises.
 */
function hasNodeSqlite(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

const HOUR = 60 * 60 * 1000;
const FIRST_EDIT_MS = Date.now() - 3 * HOUR;
const LAST_EDIT_MS = Date.now() - 2 * HOUR;

let cursorHome: string;
let projectDir: string;
let projectSlug: string;

/** The slug Cursor files a project under: leading separator dropped, `/` and `_` both `-`. */
function slugForPath(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\_]/g, '-');
}

/** One `<projects>/<slug>/agent-transcripts/<id>/<id>.jsonl` under the fixture home. */
function writeTranscript(conversationId: string, lines: unknown[], slug: string = projectSlug): void {
  const dir = join(cursorHome, 'projects', slug, 'agent-transcripts', conversationId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${conversationId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf-8'
  );
}

function userLine(text: string): unknown {
  return {
    role: 'user',
    message: { content: [{ type: 'text', text: `<timestamp>2026-09-03</timestamp><user_query>${text}</user_query>` }] },
  };
}

function assistantLine(text: string): unknown {
  return { role: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** A two-turn conversation — the shape every fixture below reuses. */
function conversation(prompt: string): unknown[] {
  return [
    userLine(prompt),
    assistantLine('on it'),
    { type: 'turn_ended', status: 'completed' },
    userLine('and the second thing'),
    assistantLine('done'),
    { type: 'turn_ended', status: 'completed' },
  ];
}

interface TrackingRow {
  conversationId: string;
  fileName: string;
  model: string;
  timestamp: number;
  source?: string;
}

/** A fixture AI-tracking database with Cursor's real table/column names. */
async function writeTrackingDb(rows: TrackingRow[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(cursorHome, 'ai-tracking');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'ai-code-tracking.db'));
  db.exec(
    'CREATE TABLE ai_code_hashes (conversationId TEXT, fileName TEXT, model TEXT, timestamp INTEGER, source TEXT)'
  );
  const insert = db.prepare(
    'INSERT INTO ai_code_hashes (conversationId, fileName, model, timestamp, source) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.conversationId, row.fileName, row.model, row.timestamp, row.source ?? 'composer');
  }
  db.close();
}

/** A database Cursor could plausibly ship after a schema change: valid file, unknown table. */
async function writeSchemaDriftedDb(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(cursorHome, 'ai-tracking');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'ai-code-tracking.db'));
  db.exec('CREATE TABLE ai_code_events (conversation_uuid TEXT, path TEXT)');
  db.close();
}

/** Not a database at all — a corrupt or half-written file. */
function writeCorruptDb(): void {
  const dir = join(cursorHome, 'ai-tracking');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ai-code-tracking.db'), 'this is not a sqlite file', 'utf-8');
}

/** A managed agent's native session, for contrast with the unmanaged Cursor rows. */
const claudeDiscovery: DiscoveredNative = {
  agentName: 'claude',
  descriptor: {
    sessionId: 'cl1',
    filePath: '/logs/cl1.jsonl',
    projectPath: '/repo/app',
    createdAt: Date.now() - HOUR,
    updatedAt: Date.now(),
    agentName: 'claude',
  },
};

const claudeParsed = {
  sessionId: 'cl1',
  agentName: 'claude',
  metadata: {},
  messages: [
    { type: 'assistant', timestamp: '2026-09-03T10:00:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
  ],
  metrics: { tools: {} },
} as never;

interface SeamRun {
  rows: RawSessionData[];
  /** Every session the loader asked the Cursor adapter to parse, as the adapter returned it. */
  parsed: ParsedSession[];
}

/**
 * Load native sessions the way `SessionsSource` does, but with only the Cursor adapter (plus an
 * optional managed-agent contrast row) behind the discovery dependency.
 */
async function runLoader(options: { withManagedClaude?: boolean } = {}): Promise<SeamRun> {
  vi.resetModules();
  const { AgentRegistry } = await import('../../../../agents/registry.js');
  const { loadNativeSessions } = await import('../native-loader.js');

  const adapter = AgentRegistry.getAgent('cursor')?.getSessionAdapter?.();
  if (!adapter?.discoverSessions) {
    throw new Error('cursor session adapter is not reachable through the registry');
  }

  const parsed: ParsedSession[] = [];
  const deps: NativeLoaderDeps = {
    trackedLogPaths: () => new Set<string>(),
    async discover(maxAgeDays) {
      const descriptors = await adapter.discoverSessions!({ maxAgeDays });
      const found: DiscoveredNative[] = descriptors.map((descriptor) => ({
        agentName: descriptor.agentName ?? 'cursor',
        descriptor,
      }));
      return options.withManagedClaude ? [...found, claudeDiscovery] : found;
    },
    async parse(agentName, filePath, sessionId) {
      if (agentName !== 'cursor') {
        return claudeParsed;
      }
      const session = await adapter.parseSessionFile(filePath, sessionId);
      parsed.push(session);
      return session;
    },
    realPath: (p) => p,
    hasOwnershipMarker: () => false,
  };

  return { rows: await loadNativeSessions(undefined, deps), parsed };
}

/**
 * The one gate `--include-external` applies, copied from `sources/sessions-source.ts` so the
 * default-visibility claim is asserted against the real predicate rather than a paraphrase.
 */
function visible(rows: RawSessionData[], includeExternal: boolean): RawSessionData[] {
  return rows.filter((s) => includeExternal || s.startEvent?.data.provider !== 'native-external');
}

function cursorRows(rows: RawSessionData[]): RawSessionData[] {
  return rows.filter((s) => s.startEvent?.agentName === 'cursor');
}

beforeEach(() => {
  cursorHome = mkdtempSync(join(tmpdir(), 'cursor-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'cursor-project-'));
  projectSlug = slugForPath(projectDir);
  process.env.CURSOR_HOME = cursorHome;
});

afterEach(() => {
  delete process.env.CURSOR_HOME;
  rmSync(cursorHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('loadNativeSessions — Cursor discovery and unmanaged tagging', () => {
  it('discovers every transcript in the fixture Cursor home', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    writeTranscript('conv-b', conversation('rename the module'));

    const { rows } = await runLoader();

    expect(cursorRows(rows).map((s) => s.sessionId).sort()).toEqual(['conv-a', 'conv-b']);
  });

  it('ignores Cursor project directories that hold no agent transcripts', async () => {
    // `projects/` also carries window ids and canvas/terminal/mcp-only directories.
    mkdirSync(join(cursorHome, 'projects', 'empty-window', 'canvases'), { recursive: true });
    mkdirSync(join(cursorHome, 'projects', '1749283', 'terminals'), { recursive: true });
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { rows } = await runLoader();

    expect(cursorRows(rows)).toHaveLength(1);
  });

  it('tags Cursor sessions native-unmanaged, not native-external', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.provider).toBe('native-unmanaged');
  });

  it('shows Cursor sessions without --include-external, unlike a managed agent’s native session', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { rows } = await runLoader({ withManagedClaude: true });

    // The unowned Claude row is the contrast: managed agent, so it is gated behind the flag.
    expect(rows.find((s) => s.sessionId === 'cl1')!.startEvent!.data.provider).toBe('native-external');

    const byDefault = visible(rows, false).map((s) => s.sessionId);
    expect(byDefault).toContain('conv-a');
    expect(byDefault).not.toContain('cl1');
    expect(visible(rows, true).map((s) => s.sessionId)).toContain('cl1');
  });

  it('carries the transcript’s prompts and turns onto the synthesized row', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { rows } = await runLoader();
    const row = cursorRows(rows)[0];

    expect(row.endEvent!.data.totalTurns).toBe(2);
    // The prompt is unwrapped from Cursor's <user_query> envelope, so the report titles the
    // session with the question rather than with a date.
    expect(row.deltas[0].userPrompts?.[0].text).toBe('add cursor analytics');
  });
});

describe.skipIf(!hasNodeSqlite())('loadNativeSessions — Cursor enrichment from the AI-tracking database', () => {
  it('adds model, files touched and the edit-derived activity window', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeTrackingDb([
      {
        conversationId: 'conv-a',
        fileName: join(projectDir, 'src', 'app.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: FIRST_EDIT_MS,
      },
      {
        conversationId: 'conv-a',
        fileName: join(projectDir, 'src', 'index.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: LAST_EDIT_MS,
      },
    ]);

    const { rows } = await runLoader();
    const row = cursorRows(rows)[0];

    expect(row.deltas[0].models).toEqual(['claude-4.5-sonnet', 'claude-4.5-sonnet']);
    expect(row.deltas[0].fileOperations?.map((f) => f.path).sort()).toEqual(
      [join(projectDir, 'src', 'app.ts'), join(projectDir, 'src', 'index.ts')].sort()
    );
    expect(row.startEvent!.data.startTime).toBe(FIRST_EDIT_MS);
    expect(row.endEvent!.data.endTime).toBe(LAST_EDIT_MS);
    // The project root is recovered by matching the recorded files back against Cursor's slug.
    expect(row.startEvent!.data.workingDirectory).toBe(projectDir);
  });

  it('reports a model recorded as "default" as unknown rather than guessing one', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeTrackingDb([
      {
        conversationId: 'conv-a',
        fileName: join(projectDir, 'src', 'app.ts'),
        model: 'default',
        timestamp: FIRST_EDIT_MS,
      },
    ]);

    const { rows } = await runLoader();
    const row = cursorRows(rows)[0];

    expect(row.deltas[0].models).toEqual([]);
    // Enrichment still happened — only the meaningless model string was dropped.
    expect(row.deltas[0].fileOperations?.map((f) => f.path)).toEqual([join(projectDir, 'src', 'app.ts')]);
  });

  it('ignores human-attributed edits, which are not the agent’s work', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeTrackingDb([
      {
        conversationId: 'conv-a',
        fileName: join(projectDir, 'typed-by-hand.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: FIRST_EDIT_MS,
        source: 'human',
      },
    ]);

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].deltas[0].fileOperations).toEqual([]);
  });

  it('produces no session for a conversation that exists only in the database', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeTrackingDb([
      {
        conversationId: 'composer-only',
        fileName: join(projectDir, 'src', 'app.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: FIRST_EDIT_MS,
      },
    ]);

    const { rows } = await runLoader();

    expect(cursorRows(rows).map((s) => s.sessionId)).toEqual(['conv-a']);
  });
});

describe('loadNativeSessions — Cursor degrades to transcript-only rows', () => {
  it('still reports the session when the tracking database is missing', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { rows } = await runLoader();
    const row = cursorRows(rows)[0];

    expect(row.sessionId).toBe('conv-a');
    expect(row.deltas[0].models).toEqual([]);
    expect(row.deltas[0].fileOperations).toEqual([]);
    // The project still resolves without a database: the slug is walked against the filesystem.
    expect(row.startEvent!.data.workingDirectory).toBe(projectDir);
    // The window falls back to the transcript file's own birth/modification times.
    expect(row.startEvent!.data.startTime).toBeGreaterThan(0);
  });

  it('still reports the session when the tracking database is corrupt', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    writeCorruptDb();

    const { rows } = await runLoader();

    expect(cursorRows(rows).map((s) => s.sessionId)).toEqual(['conv-a']);
    expect(cursorRows(rows)[0].deltas[0].models).toEqual([]);
  });

  it.skipIf(!hasNodeSqlite())('still reports the session when the database schema has drifted', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeSchemaDriftedDb();

    const { rows } = await runLoader();

    expect(cursorRows(rows).map((s) => s.sessionId)).toEqual(['conv-a']);
    expect(cursorRows(rows)[0].deltas[0].fileOperations).toEqual([]);
  });
});

describe('loadNativeSessions — Cursor absent', () => {
  it('yields no Cursor sessions when there is no Cursor home', async () => {
    process.env.CURSOR_HOME = join(cursorHome, 'does-not-exist');

    const { rows } = await runLoader({ withManagedClaude: true });

    expect(cursorRows(rows)).toEqual([]);
    // The rest of the report is unaffected: Cursor simply is not there.
    expect(rows.map((s) => s.sessionId)).toEqual(['cl1']);
  });

  it('yields no Cursor sessions when the Cursor home is empty', async () => {
    mkdirSync(join(cursorHome, 'projects'), { recursive: true });

    const { rows } = await runLoader();

    expect(rows).toEqual([]);
  });
});

describe('loadNativeSessions — Cursor never reports tokens, cost or line counts', () => {
  it('states why usage is unavailable instead of reporting zero', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));

    const { parsed } = await runLoader();

    expect(parsed).toHaveLength(1);
    expect(parsed[0].usageMeta?.usageUnavailableReason).toEqual(expect.stringContaining('Cursor'));
    // A blank-with-a-reason session must not also claim a measured zero.
    expect(parsed[0].usageMeta).not.toHaveProperty('totalTokens');
    expect(parsed[0].usageMeta).not.toHaveProperty('premiumRequests');
  });

  it.skipIf(!hasNodeSqlite())('reports edited files without inventing line counts', async () => {
    writeTranscript('conv-a', conversation('add cursor analytics'));
    await writeTrackingDb([
      {
        conversationId: 'conv-a',
        fileName: join(projectDir, 'src', 'app.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: FIRST_EDIT_MS,
      },
    ]);

    const { rows } = await runLoader();
    const operation = cursorRows(rows)[0].deltas[0].fileOperations![0];

    expect(operation.type).toBe('edit');
    expect(operation.linesAdded).toBeUndefined();
    expect(operation.linesRemoved).toBeUndefined();
    expect(operation.linesModified).toBeUndefined();
  });
});

/**
 * Cursor's project slug is lossy — it replaces `/` and `_` alike with `-` — so a slug cannot be
 * reversed by splitting on `-`. Nearly every real project trips this: a home directory like
 * `/Users/ada_lovelace` or any project named `claude-code-router` de-slugs to a path that does
 * not exist, and the session loses its project. These tests pin the recovery, and they use no
 * tracking database on purpose: the database covers only the conversations it recorded edits
 * for, so the slug is the only project signal the majority of sessions have.
 */
describe('loadNativeSessions — Cursor project attribution from a lossy slug', () => {
  it('recovers a project whose directory name contains a hyphen', async () => {
    const project = join(projectDir, 'claude-code-router');
    mkdirSync(project, { recursive: true });
    writeTranscript('conv-hyphen', conversation('ship it'), slugForPath(project));

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.workingDirectory).toBe(project);
  });

  it('recovers a project whose path contains an underscore', async () => {
    const project = join(projectDir, 'my_project');
    mkdirSync(project, { recursive: true });
    writeTranscript('conv-underscore', conversation('ship it'), slugForPath(project));

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.workingDirectory).toBe(project);
  });

  it('stays silent rather than guessing when no candidate directory exists', async () => {
    writeTranscript('conv-gone', conversation('ship it'), 'Users-nobody-vanished-project');

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.workingDirectory).toBe('Unknown');
  });
});

/**
 * Cursor stamps every user prompt with a human-readable `<timestamp>`. It is the only timing
 * signal for a conversation the tracking database never recorded an edit for, and it beats the
 * transcript file's birth/modification times badly: file times measure when the file was
 * touched, so a session resumed days later reports a span of days rather than of minutes.
 */
describe('loadNativeSessions — Cursor activity window from transcript timestamps', () => {
  /** A user line stamped the way Cursor writes it. */
  function stampedUserLine(stamp: string, text: string): unknown {
    return {
      role: 'user',
      message: {
        content: [{ type: 'text', text: `<timestamp>${stamp}</timestamp><user_query>${text}</user_query>` }],
      },
    };
  }

  it('takes the window from the first and last stamped prompt', async () => {
    writeTranscript('conv-stamped', [
      stampedUserLine('Monday, Aug 31, 2026, 5:46 PM (UTC+3)', 'first'),
      assistantLine('on it'),
      stampedUserLine('Monday, Aug 31, 2026, 6:31 PM (UTC+3)', 'second'),
      assistantLine('done'),
    ]);

    const { rows } = await runLoader();
    const row = cursorRows(rows)[0];

    expect(row.startEvent!.data.startTime).toBe(Date.parse('2026-08-31T17:46:00+03:00'));
    expect(row.endEvent!.data.endTime).toBe(Date.parse('2026-08-31T18:31:00+03:00'));
  });

  it.skipIf(!hasNodeSqlite())('still prefers the tracking database when it recorded edits', async () => {
    writeTranscript('conv-both', [
      stampedUserLine('Monday, Aug 31, 2026, 5:46 PM (UTC+3)', 'first'),
      assistantLine('done'),
    ]);
    await writeTrackingDb([
      {
        conversationId: 'conv-both',
        fileName: join(projectDir, 'src', 'app.ts'),
        model: 'claude-4.5-sonnet',
        timestamp: FIRST_EDIT_MS,
      },
    ]);

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.startTime).toBe(FIRST_EDIT_MS);
  });

  it('falls back to file times when no prompt is stamped', async () => {
    writeTranscript('conv-unstamped', [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>no stamp here</user_query>' }] } },
      assistantLine('done'),
    ]);

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.startTime).toBeGreaterThan(0);
  });
});

/**
 * `/`, `_` and `-` all slugify to `-`, so one slug can describe two directories that both
 * exist. Guessing between them would attribute a session confidently to the wrong project,
 * which is worse than the honest gap of reporting none.
 */
describe('loadNativeSessions — Cursor refuses to guess between equally valid projects', () => {
  it('reports no project when two directories share the slug', async () => {
    mkdirSync(join(projectDir, 'my_app'), { recursive: true });
    mkdirSync(join(projectDir, 'my-app'), { recursive: true });
    writeTranscript('conv-ambiguous', conversation('ship it'), slugForPath(join(projectDir, 'my-app')));

    const { rows } = await runLoader();

    expect(cursorRows(rows)[0].startEvent!.data.workingDirectory).toBe('Unknown');
  });
});
