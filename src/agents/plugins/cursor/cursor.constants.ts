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
 * What Cursor's AI-tracking database writes when the user left model choice to Cursor.
 *
 * It names no model, so it must never be reported as one — the report would be claiming a
 * model Cursor never recorded.
 */
export const CURSOR_AUTO_MODEL_SENTINEL = 'default';

/**
 * How Cursor itself labels that mode.
 *
 * Cursor's own usage export writes `auto` in its Model column for exactly the conversations the
 * local database marks `default`, so "Auto" is Cursor's word rather than our invention. Showing
 * it beats showing a blank: "Auto" says the user delegated the choice, where a blank would
 * suggest CodeMie failed to read something.
 */
export const CURSOR_AUTO_MODEL_LABEL = 'Auto';
