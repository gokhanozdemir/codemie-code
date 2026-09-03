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
 * - the analytics ownership gate (`isAnalyticsOnlyAgent` in `native-loader.ts`) skips it.
 *   That gate exists to hide unmanaged runs of an agent CodeMie CAN manage; Cursor has no
 *   managed variant, so applying it would tag every Cursor session `native-external` and drop
 *   the whole agent from the default report.
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
