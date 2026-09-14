/**
 * The Cursor usage export, converted into the shapes the rest of analytics already speaks.
 *
 * These tests drive the real parser (`loadCursorUsageCsv`) over the real fixtures rather than
 * hand-built event objects, so what is asserted here is what a Cursor dashboard export actually
 * produces. The verified 2026-09-05 export — 61 events, 39,952,466 tokens, $25.25 — is the
 * yardstick: whatever the matcher decides, the run's totals must equal that file's totals
 * exactly once. Conservation is the property that makes the conversion safe to fold into every
 * headline figure; double-counting or dropping a remainder is the failure this file exists to
 * catch.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCursorUsageSessions } from '../cursor-usage-loader.js';
import { loadCursorUsageCsv, parseCursorUsageCsv } from '../../../../agents/plugins/cursor/cursor.usage-csv.js';
import type { CursorUsageImport } from '../../../../agents/plugins/cursor/cursor.usage-csv.js';
import type { RawSessionData } from '../data-loader.js';
import type { SessionCostIndex } from '../cost/types.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'agents', 'plugins', 'cursor', '__tests__', 'fixtures');

function load(name: string): CursorUsageImport {
  const usage = loadCursorUsageCsv(join(FIXTURES, name));
  if (!usage) {
    throw new Error(`fixture ${name} did not parse as a Cursor usage export`);
  }
  return usage;
}

function totals(index: SessionCostIndex): { costUSD: number; tokens: number } {
  return {
    costUSD: [...index.values()].reduce((s, c) => s + c.costUSD, 0),
    tokens: [...index.values()].reduce((s, c) => s + c.tokens.total, 0),
  };
}

/** A Cursor session covering [start, end], shaped the way the native loader synthesizes one. */
function cursorSession(sessionId: string, start: number, end: number): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: start,
      codeMieSessionId: sessionId,
      agentName: 'cursor',
      syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: '/repo', startTime: start },
    },
    endEvent: {
      recordId: `${sessionId}-end`,
      type: 'session_end',
      timestamp: end,
      codeMieSessionId: sessionId,
      agentName: 'cursor',
      syncStatus: 'synced',
      data: { endTime: end, duration: end - start, totalTurns: 1 },
    },
    deltas: [],
  };
}

describe('buildCursorUsageSessions — totals are conserved', () => {
  it('accounts for the verified export exactly once when nothing matches a session', () => {
    const usage = load('cursor-usage-events-full.csv');
    expect(usage.totals).toMatchObject({ events: 61 });
    expect(usage.totals.tokens.total).toBe(39952466);
    expect(usage.totals.costUSD).toBeCloseTo(25.25, 10);

    const built = buildCursorUsageSessions(usage, []);

    expect(built.matched).toBe(0);
    expect(built.unmatched).toBe(61);
    expect(totals(built.costIndex).tokens).toBe(39952466);
    expect(totals(built.costIndex).costUSD).toBeCloseTo(25.25, 10);
    expect(built.summary.totalCostUSD).toBeCloseTo(25.25, 10);
  });

  it('still accounts for it exactly once when some events land on real sessions', () => {
    const usage = load('cursor-usage-events-full.csv');
    // One session wide enough to swallow a good share of the export, so the assertion is about
    // matched and remaining usage summing back to the file — not about an empty match path.
    const stamps = usage.events.map((e) => Date.parse(e.date)).sort((a, b) => a - b);
    const mid = stamps[Math.floor(stamps.length / 2)];
    const built = buildCursorUsageSessions(usage, [cursorSession('conv-a', stamps[0], mid)]);

    expect(built.matched).toBeGreaterThan(0);
    expect(built.matched + built.unmatched).toBe(61);
    expect(totals(built.costIndex).tokens).toBe(39952466);
    expect(totals(built.costIndex).costUSD).toBeCloseTo(25.25, 10);
  });

  it('keeps tokens and drops cost for the export variant that ships no Cost column', () => {
    const withCost = load('cursor-usage-events.csv');
    const text = [
      '"Date","User","Kind","Model","Input (w/ Cache Write)","Input (w/o Cache Write)","Cache Read","Output Tokens","Total Tokens","Requests"',
      ...withCost.events.map(
        (e) =>
          `"${e.date}","${e.user}","${e.kind}","${e.model}","${e.tokens.cacheCreation}","${e.tokens.input}","${e.tokens.cacheRead}","${e.tokens.output}","${e.tokens.total}","1"`
      ),
    ].join('\n');
    const usage = parseCursorUsageCsv(text);
    expect(usage?.hasCost).toBe(false);

    const built = buildCursorUsageSessions(usage!, []);

    expect(totals(built.costIndex).tokens).toBe(withCost.totals.tokens.total);
    expect(totals(built.costIndex).costUSD).toBe(0);
    expect(built.summary.totalCostUSD).toBe(0);
  });
});

describe('buildCursorUsageSessions — matching events to sessions', () => {
  const usage = load('cursor-usage-events.csv');
  const first = usage.events.reduce((a, b) => (Date.parse(a.date) < Date.parse(b.date) ? a : b));
  const firstMs = Date.parse(first.date);

  it('gives a containing session that event’s usage', () => {
    // Tight enough that only this one event is inside, so the assertion is about attribution
    // rather than about how many neighbours the window happened to sweep up.
    const built = buildCursorUsageSessions(usage, [cursorSession('conv-a', firstMs - 500, firstMs + 500)]);

    const cost = built.costIndex.get('conv-a');
    expect(cost).toBeDefined();
    expect(cost!.tokens.total).toBe(first.tokens.total);
    expect(cost!.costUSD).toBeCloseTo(first.costUSD, 10);
    expect(cost!.priced).toBe(true);
    expect(cost!.usageUnavailableReason).toBeUndefined();
    expect(built.matched).toBe(1);
  });

  it('sends an event inside two overlapping windows to the remainder rather than guessing', () => {
    const built = buildCursorUsageSessions(usage, [
      cursorSession('conv-a', firstMs - 60_000, firstMs + 60_000),
      cursorSession('conv-b', firstMs - 30_000, firstMs + 90_000),
    ]);

    expect(built.costIndex.has('conv-a')).toBe(false);
    expect(built.costIndex.has('conv-b')).toBe(false);
    expect(built.matched).toBe(0);
    expect(totals(built.costIndex).tokens).toBe(usage.totals.tokens.total);
  });

  it('collects everything unmatched into one pseudo-session per local day', () => {
    const built = buildCursorUsageSessions(usage, []);

    const ids = built.rawSessions.map((r) => r.sessionId).sort();
    expect(ids).toEqual(usage.byDay.map((d) => `cursor-usage:${d.day}`).sort());
    for (const day of usage.byDay) {
      const cost = built.costIndex.get(`cursor-usage:${day.day}`);
      expect(cost!.tokens.total).toBe(day.tokens.total);
      expect(cost!.costUSD).toBeCloseTo(day.costUSD, 10);
    }
    // A pseudo-session must be an ordinary Cursor session to the rest of the pipeline.
    const raw = built.rawSessions[0];
    expect(raw.startEvent!.agentName).toBe('cursor');
    expect(raw.deltas.length).toBeGreaterThan(0);
  });

  it('does not synthesize a pseudo-session for a day whose events all matched', () => {
    const sameDay = usage.events.filter((e) => e.day === first.day).map((e) => Date.parse(e.date));
    const built = buildCursorUsageSessions(usage, [
      cursorSession('conv-a', Math.min(...sameDay) - 1000, Math.max(...sameDay) + 1000),
    ]);

    expect(built.rawSessions.map((r) => r.sessionId)).not.toContain(`cursor-usage:${first.day}`);
    expect(totals(built.costIndex).tokens).toBe(usage.totals.tokens.total);
  });
});

describe('buildCursorUsageSessions — provenance and model labels', () => {
  const usage = load('cursor-usage-events-full.csv');

  it('marks every CSV-derived model line as Cursor’s own billing', () => {
    const built = buildCursorUsageSessions(usage, []);

    const lines = [...built.costIndex.values()].flatMap((c) => c.perModel);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.costBasis).toBe('vendor-billed');
      expect(line.unpriced).toBe(false);
      expect(line.estimated).toBeUndefined();
    }
  });

  it('leaves model names unsuffixed so one model cannot appear under two spellings', () => {
    const built = buildCursorUsageSessions(usage, []);

    const models = new Set([...built.costIndex.values()].flatMap((c) => c.perModel.map((m) => m.model)));
    expect(models).toContain('auto');
    expect([...models].some((m) => m.includes('(cursor)'))).toBe(false);
  });
});
