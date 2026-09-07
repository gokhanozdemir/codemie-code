/**
 * Report client cost-honesty contract test.
 *
 * The report client is a no-build vanilla IIFE, so its formatting helpers cannot be
 * imported. Like `report-views.test.ts`, this asserts the contract against the source
 * text: unmeasurable usage must render as an em dash, subscription wording must be gone,
 * and the all-unmeasurable views must carry an explicit "no local telemetry" note.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const app = readFileSync(fileURLToPath(new URL('../client/app.js', import.meta.url)), 'utf-8');

/** The source of a named `function name(...) { ... }` declaration, to its balanced closing brace. */
function fnBody(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** The body of a top-level `VIEWS.<name> = function (...) { ... }` block. */
function viewSource(name: string): string {
  const start = app.indexOf(`VIEWS.${name} = function`);
  expect(start, `VIEWS.${name} not found`).toBeGreaterThan(-1);
  const end = app.indexOf('\n  VIEWS.', start + 1);
  return app.slice(start, end === -1 ? app.length : end);
}

describe('report client cost honesty', () => {
  it('never labels unknown cost with subscription wording', () => {
    expect(app).not.toMatch(/'Included'|"Included"/);
    expect(app).not.toMatch(/covered by subscription/i);
  });

  it('formats unmeasurable cost and tokens as an em dash', () => {
    expect(app).toMatch(/UNKNOWN_LABEL\s*=\s*'—'/);
    // Per-session formatters dash on the session's own provenance; the aggregate one only
    // when the whole group is unmeasurable, so a mixed group keeps showing the measured sum.
    expect(fnBody('fmtUSDOf')).toMatch(/usageUnknown\(s\).*UNKNOWN_LABEL/);
    expect(fnBody('fmtTokensOf')).toMatch(/usageUnknown\(s\).*UNKNOWN_LABEL/);
    expect(fnBody('fmtUSDAgg')).toMatch(/anyMeasured\(list\).*UNKNOWN_LABEL/);
  });

  it('keeps mixed aggregates on the measured sum (aggregates dash only when nothing is measured)', () => {
    expect(fnBody('anyMeasured')).toMatch(/\.some\(.*!usageUnknown\(s\)/);
  });

  it('states missing local telemetry in the session modal instead of a subscription', () => {
    expect(app).toMatch(/usageUnknown\(s\) \? 'no local token telemetry' : 'API-equivalent'/);
  });
});

describe('report client all-unmeasurable empty state', () => {
  const overview = viewSource('overview');
  const cost = viewSource('cost');

  it('derives Overview cost and token KPIs from measured-set semantics', () => {
    expect(overview).toMatch(/measured\s*=\s*anyMeasured\(fs\)/);
    // Est. cost and every token KPI must go through `measured`, not a bare `totalCost`/`tTotal` truth test.
    expect(overview).toMatch(/'Est\. cost', measured \? fmtUSD\(totalCost\) : UNKNOWN_LABEL/);
    expect(overview).toMatch(/tkv = function \(v\) \{ return measured &&[^}]*UNKNOWN_LABEL/);
  });

  it('explains the absent local token telemetry on Overview and Cost', () => {
    expect(app).toMatch(/NO_TELEMETRY_NOTE\s*=\s*'[^']*local token telemetry[^']*'/);
    // Both views share one helper, so the note cannot drift between them.
    expect(fnBody('appendNoTelemetryNote')).toMatch(/!anyMeasured\(list\).*NO_TELEMETRY_NOTE/);
    expect(overview).toMatch(/appendNoTelemetryNote\(host, fs\)/);
    expect(cost).toMatch(/appendNoTelemetryNote\(host, fs\)/);
  });

  it('keeps agent chips filtering by agent name only', () => {
    expect(app).toMatch(/state\.agents\.has\(s\.agentName\)/);
    expect(app).not.toMatch(/state\.agents\.has\(s\.model/);
  });

  it('keeps tool-call aggregation independent of usage measurability', () => {
    // Tool tables read toolCalls/toolCallsTotal directly; they must not be gated on usage.
    const toolStart = app.indexOf('var toolAgg');
    const toolBlock = app.slice(toolStart, app.indexOf("card('Tool usage & success rate')", toolStart));
    expect(toolBlock).not.toMatch(/usageUnknown|anyMeasured/);
  });
});

/**
 * Cursor Team Analytics is a remote, opt-in source. The report must keep it visibly apart from
 * local sessions — it has no session key to join on and no token/cost fields to join with.
 */
describe('Cursor Team Analytics section separation', () => {
  const view = viewSource('cursorteam');

  it('renders from meta, never from the session list', () => {
    expect(view).toMatch(/DATA\.meta\.cursorTeamAnalytics/);
    // The view takes no session array and must not reach for one.
    expect(view).toMatch(/VIEWS\.cursorteam = function \(host\)/);
    expect(view).not.toMatch(/DATA\.sessions|SESSION_BY_ID|filtered\(\)/);
  });

  it('contributes nothing to any cost or token figure', () => {
    expect(view).not.toMatch(/costUSD|fmtUSD|fmtTokens/);
  });

  it('says plainly that the remote rows are not joined to local sessions', () => {
    expect(view).toMatch(/nothing here is joined to the local sessions/);
  });

  it('flags a partial pull rather than presenting it as complete', () => {
    expect(view).toMatch(/failedEndpoints/);
  });
});
