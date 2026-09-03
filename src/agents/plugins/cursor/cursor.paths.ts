/**
 * Cursor storage locations.
 *
 * Cursor keeps its user data under `~/.cursor`. `CURSOR_HOME` overrides it, mirroring the
 * `COPILOT_HOME` handling in `copilot-cli.paths.ts` — which is also what lets the adapter
 * be driven against a fixture tree in tests.
 */

import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

/** `~/.cursor`, or `$CURSOR_HOME` when set. */
export function getCursorHome(): string {
  const override = process.env.CURSOR_HOME?.trim();
  if (override) {
    return override;
  }
  return resolveHomeDir('.cursor');
}

/** Directory holding one subdirectory per project, each keyed by a slug of its path. */
export function getCursorProjectsRoot(): string {
  return join(getCursorHome(), 'projects');
}

/** Cursor's AI-tracking SQLite database — the only local source of model and timing data. */
export function getCursorTrackingDbPath(): string {
  return join(getCursorHome(), 'ai-tracking', 'ai-code-tracking.db');
}
