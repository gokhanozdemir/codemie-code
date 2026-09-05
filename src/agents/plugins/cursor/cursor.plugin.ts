/**
 * Cursor agent plugin — analytics only.
 *
 * Cursor is an IDE that CodeMie neither installs, launches, configures nor updates; it is
 * read for the analytics report and nothing else. That is exactly what `analyticsOnly: true`
 * declares, and it is load-bearing in two places:
 *
 * - `AgentRegistry.getManageableAgents()` filters on it, which keeps Cursor out of every
 *   management surface (install, uninstall, update, list, doctor, first-run). `codemie update`
 *   in particular would otherwise run `npm install -g` against a package Cursor does not have.
 * - the analytics ownership gate in `native-loader.ts` applies to Cursor like any other agent:
 *   a session CodeMie cannot prove it launched is external, so Cursor sessions are opt-in
 *   behind `--include-external`. Since CodeMie never launches Cursor today, that is all of
 *   them; set one up through CodeMie and the ownership marker makes it show with no flag.
 *
 * There is therefore no npm package, no CLI command, no env mapping and no provider list —
 * none of the launch machinery is ever reached. The plugin exists solely to hand the registry
 * a session adapter.
 */

import type { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { CURSOR_AGENT_NAME, CURSOR_DISPLAY_NAME } from './cursor.constants.js';
import { CursorSessionAdapter } from './cursor.session.js';

export const CursorPluginMetadata: AgentMetadata = {
  name: CURSOR_AGENT_NAME,
  displayName: CURSOR_DISPLAY_NAME,
  description: 'Cursor - AI code editor; read for analytics, never managed by CodeMie',
  npmPackage: null,
  cliCommand: null,
  dataPaths: {
    home: '.cursor',
  },
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },
  supportedProviders: [],
  analyticsOnly: true,
};

export class CursorPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter | null = null;

  constructor() {
    super(CursorPluginMetadata);
  }

  /**
   * Built lazily: a `codemie` run that never touches analytics should not pay to construct
   * the adapter, and the registry instantiates every plugin at startup.
   */
  getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new CursorSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }
}
