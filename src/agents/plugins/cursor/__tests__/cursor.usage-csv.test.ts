/**
 * Cursor usage-events CSV import.
 *
 * The fixture is a slice of a real 2026-09-05 export, so the header set, the quoting, and the
 * token magnitudes are the ones the product will actually meet. Its defining property: every
 * row is `Kind=Included` and yet carries real tokens and a real `Cost` — the whole reason this
 * import exists, and the thing a naive reading of "Included" would throw away.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseCursorUsageCsv, loadCursorUsageCsv } from '../cursor.usage-csv.js';
import { readFileSync } from 'node:fs';

const fixturePath = fileURLToPath(new URL('./fixtures/cursor-usage-events.csv', import.meta.url));
const fixture = readFileSync(fixturePath, 'utf-8');

describe('parseCursorUsageCsv', () => {
  it('keeps tokens and cost for Included rows instead of reading them as free', () => {
    const out = parseCursorUsageCsv(fixture)!;
    expect(out.events).toHaveLength(8);
    expect(out.events.every((e) => e.kind === 'Included')).toBe(true);
    expect(out.totals.costUSD).toBeCloseTo(3.87, 2);
    expect(out.totals.tokens.total).toBe(4183618);
    expect(out.totals.tokens.output).toBe(48138);
    // Cache read is the bulk of Cursor usage and must not be folded into plain input.
    expect(out.totals.tokens.cacheRead).toBe(3437315);
    expect(out.totals.tokens.cacheCreation).toBe(168695);
    expect(out.totals.tokens.input).toBe(529470);
  });

  it('groups by day and model so the section can show provenance without inventing a session key', () => {
    const out = parseCursorUsageCsv(fixture)!;
    const auto = out.byModel.find((m) => m.model === 'auto')!;
    expect(auto.events).toBe(4);
    expect(auto.costUSD).toBeCloseTo(0.58, 2);
    expect(out.byDay.map((d) => d.day)).toEqual(['2026-08-28', '2026-09-05']);
  });

  it('filters to one user when asked, and reports who it actually found', () => {
    const mixed = fixture.replace('"owner@example.com"', '"someone.else@example.com"');
    const out = parseCursorUsageCsv(mixed, { userEmail: 'owner@example.com' })!;
    expect(out.events).toHaveLength(7);
    expect(out.usersInFile.sort()).toEqual(['owner@example.com', 'someone.else@example.com']);
    expect(out.droppedByUserFilter).toBe(1);
  });

  it('reports when the user filter matched nothing, rather than silently emptying the section', () => {
    const out = parseCursorUsageCsv(fixture, { userEmail: 'nobody@example.com' });
    expect(out).not.toBeNull();
    expect(out!.events).toHaveLength(0);
    expect(out!.droppedByUserFilter).toBe(8);
    expect(out!.usersInFile).toEqual(['owner@example.com']);
  });

  it('tolerates the export variant that has no Cost column', () => {
    // The 380-row 2026-09-05 export ships `Requests` in place of `Cost`.
    const noCost = fixture
      .replace('"Total Tokens","Cost"', '"Total Tokens","Requests"')
      .replace(/,"\d+\.\d+"\r?\n/g, ',"3.1"\n');
    const out = parseCursorUsageCsv(noCost)!;
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.hasCost).toBe(false);
    expect(out.totals.costUSD).toBe(0);
    // Tokens are still the point — they must survive a missing Cost column.
    expect(out.totals.tokens.total).toBeGreaterThan(0);
  });

  it('tolerates added columns and non-numeric cost values', () => {
    const odd = fixture
      .replace('"Cost"', '"Cost","Some New Column"')
      .replace(/("\d+\.\d+")\r?\n/g, '$1,"x"\n')
      .replace('"0.07","x"', '"Free","x"');
    const out = parseCursorUsageCsv(odd)!;
    expect(out.events).toHaveLength(8);
    expect(out.totals.costUSD).toBeCloseTo(3.80, 2); // the 0.07 row contributed nothing
  });

  it('returns null for a file that is not a usage export', () => {
    expect(parseCursorUsageCsv('name,value\nfoo,1\n')).toBeNull();
    expect(parseCursorUsageCsv('')).toBeNull();
  });
});

describe('loadCursorUsageCsv', () => {
  it('reads a real export off disk', () => {
    const out = loadCursorUsageCsv(fixturePath)!;
    expect(out.events).toHaveLength(8);
    expect(out.sourceFile).toBe(fixturePath);
  });

  it('fails soft on a missing file instead of throwing', () => {
    expect(loadCursorUsageCsv('/no/such/export.csv')).toBeNull();
  });
});
