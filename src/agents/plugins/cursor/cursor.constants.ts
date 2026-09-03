/**
 * Shared Cursor identifiers.
 *
 * These live apart from `cursor.plugin.ts` so the session adapter can use them without
 * importing the plugin, which imports the adapter — a cycle.
 */

/** Internal agent key. */
export const CURSOR_AGENT_NAME = 'cursor';

/** User-facing label shown in the analytics report and terminal output. */
export const CURSOR_DISPLAY_NAME = 'Cursor';

/**
 * Cursor records a model of `default` when the user left model selection to Cursor. That
 * string names no model, so it is dropped rather than reported — see the honest-gaps note
 * in `cursor.session.ts`.
 */
export const CURSOR_UNKNOWN_MODEL = 'default';
