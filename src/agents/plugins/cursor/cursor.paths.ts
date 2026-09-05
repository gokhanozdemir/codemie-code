/**
 * Cursor storage locations.
 *
 * Cursor keeps its user data under `~/.cursor`. `CURSOR_HOME` overrides it, mirroring the
 * `COPILOT_HOME` handling in `copilot-cli.paths.ts` — which is also what lets the adapter
 * be driven against a fixture tree in tests.
 *
 * `state.vscdb` is a second, unrelated Cursor data location: it is the VS Code/Cursor
 * *application* state store, not `~/.cursor` (which holds Cursor's own project/tracking
 * data), so it lives under the OS's per-app-data directory (see ADR
 * `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`). `CURSOR_HOME` still doubles
 * as the test-fixture override for it — same rationale as above — under a `User/globalStorage`
 * layout that mirrors where Cursor actually keeps it relative to its app-data root.
 */

import { homedir } from 'os';
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

/**
 * Cursor's (VS Code-derived) per-user application-data directory: the real, OS-specific home
 * of `state.vscdb`. Not `~/.cursor` — that is Cursor's own project/tracking data, a separate
 * tree from the editor shell's VS Code-inherited state.
 */
function getCursorAppDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor');
    case 'win32': {
      const appData = process.env.APPDATA;
      return appData ? join(appData, 'Cursor') : join(home, 'AppData', 'Roaming', 'Cursor');
    }
    default:
      // Linux and other Unix-likes.
      return join(home, '.config', 'Cursor');
  }
}

/**
 * `state.vscdb` — the undocumented internal store `composerHeaders` (session discovery) and
 * `cursorDiskKV` (per-turn enrichment) live in. `$CURSOR_HOME`, when set, relocates it under
 * `User/globalStorage` the same way it relocates `projects/` and `ai-tracking/`, which is what
 * lets tests point it at a fixture tree instead of the real per-OS app-data directory.
 */
export function getCursorStateDbPath(): string {
  const override = process.env.CURSOR_HOME?.trim();
  const root = override ?? getCursorAppDataDir();
  return join(root, 'User', 'globalStorage', 'state.vscdb');
}
