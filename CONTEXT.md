# CodeMie Code Analytics

Terminology for how CodeMie Code classifies agent sessions in analytics. CodeMie both launches agents itself and reads usage left behind by agents it never launched; the vocabulary below keeps those apart.

## Language

**Managed agent**:
An agent CodeMie installs, configures, and launches (e.g. claude, codex, gemini, copilot-cli).
_Avoid_: installed agent, native agent

**Analytics-only agent**:
An agent CodeMie never installs or launches but whose locally persisted sessions it reads for analytics (`analyticsOnly: true` in plugin metadata; e.g. cursor).
_Avoid_: external agent, ingestion-only agent

**External session**:
A session of a *managed* agent that was run outside CodeMie and carries no CodeMie ownership marker (provider tag `native-external`). Hidden by default; shown with `--include-external`.
_Avoid_: unmanaged session, foreign session

**Unmanaged session**:
A session of an *analytics-only* agent (provider tag `native-unmanaged`). Always shown; no flag required.
_Avoid_: external session

**Ownership marker**:
The sidecar record in `~/.codemie/sessions/` that proves CodeMie launched a given agent session; its absence is what makes a managed agent's session external.
