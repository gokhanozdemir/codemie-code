/**
 * Cursor usage-events CSV import — the member path to real Cursor tokens and cost.
 *
 * Cursor's local stores stopped carrying billable token counts (see docs/CURSOR_INTEGRATION.md),
 * and the Team Analytics API never had them. The dashboard's Usage → Export CSV does: a real
 * 2026-09-05 export held 39,952,466 tokens and $25.25 of Cost across 61 events.
 *
 * The trap this module exists to avoid: **every one of those 61 rows was `Kind=Included`.**
 * `Included` is Cursor's billing *category* — "covered by your plan" — not a statement that the
 * usage was free or unmeasured. Reading it as "no cost" would discard the only accurate usage
 * figures available. So `Kind` is recorded and never used to zero anything out.
 *
 * Two export shapes are in the wild and both must parse: most exports end with a `Cost` column,
 * while at least one variant ships `Requests` instead and has no cost at all. Tokens are the
 * durable part; cost is optional.
 *
 * Rows are per-event with no composerId, so they cannot be joined to local sessions. The report
 * renders them as their own labelled section for exactly that reason.
 */

import { readFileSync } from 'node:fs';
import { logger } from '@/utils/logger.js';

/** One usage event, normalized. Field names are ours; the CSV's are not stable enough to expose. */
export interface CursorUsageEvent {
  /** ISO timestamp as written by the export. */
  date: string;
  /** Local day key (YYYY-MM-DD) used for grouping. */
  day: string;
  user: string;
  /** Cursor's billing category — `Included`, `On-Demand`, … Recorded, never used to zero usage. */
  kind: string;
  model: string;
  maxMode: boolean;
  tokens: CursorUsageTokens;
  /** USD from the `Cost` column; 0 when the export variant has no such column. */
  costUSD: number;
}

export interface CursorUsageTokens {
  /** `Input (w/o Cache Write)` — plain prompt tokens. */
  input: number;
  /** `Input (w/ Cache Write)` — prompt tokens that also populated the cache. */
  cacheCreation: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface CursorUsageGroup {
  model: string;
  events: number;
  tokens: CursorUsageTokens;
  costUSD: number;
}

export interface CursorUsageDay {
  day: string;
  events: number;
  tokens: CursorUsageTokens;
  costUSD: number;
}

export interface CursorUsageImport {
  events: CursorUsageEvent[];
  totals: { events: number; tokens: CursorUsageTokens; costUSD: number };
  byModel: CursorUsageGroup[];
  byDay: CursorUsageDay[];
  /** False for the export variant that ships `Requests` instead of `Cost`. */
  hasCost: boolean;
  /** Every distinct `User` seen BEFORE filtering — lets a caller explain an empty result. */
  usersInFile: string[];
  /** How many rows the user filter removed, so "imported nothing" is never silent. */
  droppedByUserFilter: number;
  sourceFile?: string;
}

export interface ParseOptions {
  /** When set, keep only rows whose `User` matches (case-insensitive). */
  userEmail?: string;
}

/** Columns that must all be present for a file to be a usage export rather than some other CSV. */
const REQUIRED_COLUMNS = ['Date', 'Kind', 'Model', 'Total Tokens'];

function emptyTokens(): CursorUsageTokens {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, total: 0 };
}

function addTokens(a: CursorUsageTokens, b: CursorUsageTokens): CursorUsageTokens {
  return {
    input: a.input + b.input,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

/**
 * Minimal RFC4180 reader — the export quotes every field and its prompts never appear, but a
 * model name or a future column could still carry a comma or an escaped quote.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cost cells are mostly plain decimals but the export also writes words such as `Free`. Pull the
 * first number out and treat anything wordy as zero rather than NaN-poisoning the total.
 */
function money(v: string | undefined): number {
  const m = /-?\d+(?:\.\d+)?/.exec(String(v ?? ''));
  return m ? Number(m[0]) : 0;
}

/** Parse the text of a Cursor usage export. Returns null when it is not one. */
export function parseCursorUsageCsv(text: string, options: ParseOptions = {}): CursorUsageImport | null {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return null;
  }
  const header = rows[0].map((h) => h.trim());
  if (!REQUIRED_COLUMNS.every((c) => header.includes(c))) {
    return null;
  }
  const at = (r: string[], col: string): string | undefined => {
    const i = header.indexOf(col);
    return i === -1 ? undefined : r[i];
  };

  const hasCost = header.includes('Cost');
  const wanted = options.userEmail?.trim().toLowerCase();
  const usersInFile = new Set<string>();
  const events: CursorUsageEvent[] = [];
  let droppedByUserFilter = 0;

  for (const r of rows.slice(1)) {
    const user = (at(r, 'User') ?? '').trim();
    if (user) {
      usersInFile.add(user);
    }
    if (wanted && user.toLowerCase() !== wanted) {
      droppedByUserFilter++;
      continue;
    }
    const date = (at(r, 'Date') ?? '').trim();
    const tokens: CursorUsageTokens = {
      input: num(at(r, 'Input (w/o Cache Write)')),
      cacheCreation: num(at(r, 'Input (w/ Cache Write)')),
      cacheRead: num(at(r, 'Cache Read')),
      output: num(at(r, 'Output Tokens')),
      total: num(at(r, 'Total Tokens')),
    };
    events.push({
      date,
      day: date.slice(0, 10),
      user,
      kind: (at(r, 'Kind') ?? '').trim(),
      model: (at(r, 'Model') ?? '').trim(),
      maxMode: /^yes$/i.test((at(r, 'Max Mode') ?? '').trim()),
      tokens,
      costUSD: hasCost ? money(at(r, 'Cost')) : 0,
    });
  }

  const group = <K extends string>(keyOf: (e: CursorUsageEvent) => K) => {
    const m = new Map<K, { events: number; tokens: CursorUsageTokens; costUSD: number }>();
    for (const e of events) {
      const k = keyOf(e);
      const cur = m.get(k) ?? { events: 0, tokens: emptyTokens(), costUSD: 0 };
      cur.events++;
      cur.tokens = addTokens(cur.tokens, e.tokens);
      cur.costUSD += e.costUSD;
      m.set(k, cur);
    }
    return m;
  };

  const byModel = [...group((e) => e.model).entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokens.total - a.tokens.total);
  const byDay = [...group((e) => e.day).entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    events,
    totals: {
      events: events.length,
      tokens: events.reduce((acc, e) => addTokens(acc, e.tokens), emptyTokens()),
      costUSD: events.reduce((acc, e) => acc + e.costUSD, 0),
    },
    byModel,
    byDay,
    hasCost,
    usersInFile: [...usersInFile],
    droppedByUserFilter,
  };
}

/**
 * Read and parse an export from disk. Never throws: an unreadable or wrong-shaped file omits the
 * section and leaves the local report — the part that always works — untouched.
 */
export function loadCursorUsageCsv(path: string, options: ParseOptions = {}): CursorUsageImport | null {
  try {
    const parsed = parseCursorUsageCsv(readFileSync(path, 'utf-8'), options);
    if (!parsed) {
      logger.debug(`[cursor] usage CSV ${path} is not a Cursor usage export (unexpected columns)`);
      return null;
    }
    return { ...parsed, sourceFile: path };
  } catch (error) {
    logger.debug(`[cursor] usage CSV ${path} unreadable: ${(error as Error).message}`);
    return null;
  }
}
