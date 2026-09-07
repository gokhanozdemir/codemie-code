# External Integrations

## Service Overview

| Service | Purpose | Auth Method | Config Key |
|---------|---------|-------------|------------|
| LangGraph | Agent state machine orchestration | N/A | Framework |
| LangChain | LLM abstractions & tool calling | N/A | Framework |
| OpenAI | GPT models | API Key | `OPENAI_API_KEY` |
| Anthropic Claude | Claude models | API Key | `ANTHROPIC_API_KEY` |
| Google Gemini | Gemini models | API Key | `GOOGLE_AI_API_KEY` |
| AWS Bedrock | Claude via AWS | AWS credential chain | `AWS_REGION` + AWS auth |
| Azure OpenAI | GPT via Azure | API Key + Endpoint | `AZURE_OPENAI_*` |
| LiteLLM | 100+ provider proxy | Provider-specific | `LITELLM_BASE_URL` |
| OpenCode | Open-source AI assistant | SSO/API Key | Via CodeMie proxy |
| MCP Servers | Remote MCP tool servers | OAuth 2.0 (auto) | `codemie-mcp-proxy` |
| Enterprise SSO | Corporate auth | SAML/OAuth | `SSO_BASE_URL` |

---

## LangGraph Integration

LangGraph drives agent orchestration as a typed state machine; every node is a processing function and every edge (including conditional) is explicit routing logic.

| Concept | Role |
|---------|------|
| `StateGraph` | Manages agent state transitions |
| Node | Processing function (process / execute / validate) |
| Edge / Conditional Edge | Static or dynamic control flow |
| `workflow.compile()` | Produces the executable agent |

`file:src/agents/codemie-code/agent.ts:50-80`

---

## LangChain Integration

Use LangChain's `BaseChatModel` abstractions rather than raw HTTP calls; they provide streaming, tool calling, and retries out of the box.

| Do | Don't |
|----|-------|
| `new ChatOpenAI({ apiKey, model })` | Custom HTTP client per provider |
| Stream via `llm.stream(messages)` | Buffer entire response before yield |

`file:src/providers/plugins/openai/openai.provider.ts:30-50`

---

## Provider Plugin Contract

Every provider implements `LLMProvider` from `src/providers/core/types.ts`:

```typescript
export interface LLMProvider {
  name: string;
  createChatModel(config: ProviderConfig): BaseChatModel;
  validateConfig(config: ProviderConfig): Promise<void>;
  getDefaultModel(): string;
  getSupportedModels(): string[];
}
```

`file:src/providers/core/types.ts:10-30`

Registered providers: OpenAI, Anthropic, AWS Bedrock, Azure OpenAI, LiteLLM, Enterprise SSO.

---

## Profile-Based Provider Selection

Profiles select the active provider at runtime. Priority: CLI args > env vars > project config > global config > defaults.

| Profile | Provider type | Key config |
|---------|--------------|------------|
| `default` | `openai` | `OPENAI_API_KEY`, model `gpt-4` |
| `work` | `sso` | `SSO_BASE_URL`, `workspace` |
| `aws` | `bedrock` | `AWS_REGION`, Bedrock model ARN |

Switch with `codemie profile use <name>`. `file:src/env/config-loader.ts:100-130`

---

## Authentication Patterns

### API Key (OpenAI / Anthropic / Gemini / Azure)

Read from environment variable; never hardcode. `file:src/providers/plugins/openai/openai.provider.ts`

### AWS Bedrock

Uses the standard AWS credential chain (env → profile → instance role). No custom auth code needed.

### Enterprise SSO

Credentials stored in `CredentialStore` with auto-refresh. Project list merges `applications` + `applicationsAdmin` (deduplicated, sorted alphabetically; auto-selected when only one). `file:src/providers/plugins/sso/sso.setup-steps.ts:93-106`

| Auth Type | Retry on failure? | Error class |
|-----------|------------------|-------------|
| API Key | No — throw `ConfigurationError` | `ConfigurationError` |
| SSO token expired | No — re-run `codemie setup` | `ConfigurationError` |
| AWS credentials missing | No | `ConfigurationError` |

---

## Error Handling & Retries

Classify errors before deciding to retry. `file:src/providers/core/retry-handler.ts:20-40`

| Error | HTTP Status | Action |
|-------|-------------|--------|
| Rate limit | 429 | Exponential backoff, retry |
| Auth error | 401 / 403 | No retry — throw `ConfigurationError` |
| Server error | 500–599 | Retry with backoff |
| Client error | 400–499 (not 429) | No retry |
| Timeout | — | Retry with longer timeout |

---

## LiteLLM Proxy

LiteLLM exposes an OpenAI-compatible API; use `ChatOpenAI` pointed at `baseURL`. `file:src/providers/plugins/litellm/litellm.provider.ts:20-40`

```typescript
const llm = new ChatOpenAI({
  apiKey: config.apiKey,
  model: config.model,
  configuration: { baseURL: config.baseUrl || 'http://localhost:4000' }
});
```

Supported via proxy: OpenAI, Anthropic, Gemini, Cohere, Azure, AWS, GCP, Ollama, custom OpenAI-compatible endpoints.

---

## OpenCode Integration

### Two Deployment Modes

| Mode | Package | Install | Use case |
|------|---------|---------|----------|
| Built-in (`codemie-code`) | `@codemieai/codemie-opencode` binary | Bundled — no install | Default experience |
| Standalone (`opencode`) | `opencode-ai` npm (global) | `codemie install opencode` | Users who prefer standalone |

Both share: SSO/proxy routing, session analytics, model config injection.

### Config Injection

CodeMie injects model config via env vars before spawning OpenCode:
- `OPENCODE_CONFIG_CONTENT` (primary) — inline JSON
- `OPENCODE_CONFIG` (fallback) — path to temp file

`file:src/agents/plugins/opencode/opencode.plugin.ts:215-260`

### Session Analytics Flow

1. OpenCode exits → grace period for file writes
2. `onSessionEnd` hook: discovers and processes latest session → writes JSONL deltas
3. `SessionSyncer` reads JSONL → POSTs to `v1/metrics` API

`file:src/agents/plugins/opencode/opencode.plugin.ts:145-326`

### XDG Storage Paths

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/opencode/storage/` |
| macOS | `~/Library/Application Support/opencode/storage/` |
| Windows | `%LOCALAPPDATA%\opencode\storage\` |

`file:src/agents/plugins/opencode/opencode.paths.ts`

### Key Session Types

`file:src/agents/plugins/opencode/opencode-message-types.ts` — defines `OpenCodeSession`, `OpenCodeMessage`, `OpenCodeTokens`.

### Session Adapter

`file:src/agents/plugins/opencode/opencode.session.ts:72-100` — `OpenCodeSessionAdapter` implements `discoverSessions`, `parseSessionFile`, `processSession` with retry logic for concurrent writes.

### Metrics Processor

`file:src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts` — priority 1; extracts tokens, duration, cost; writes deduplicated JSONL deltas.

---

## MCP Server Integration

The MCP proxy bridges stdio JSON-RPC to streamable HTTP with automatic OAuth 2.0.

| Component | File | Purpose |
|-----------|------|---------|
| Stdio-HTTP Bridge | `src/mcp/stdio-http-bridge.ts` | JSON-RPC stdin ↔ HTTP |
| OAuth Provider | `src/mcp/auth/mcp-oauth-provider.ts` | Browser-based auth code flow |
| Callback Server | `src/mcp/auth/callback-server.ts` | Ephemeral localhost OAuth callback |
| MCP Auth Plugin | `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts` | URL rewriting + SSRF protection |

**OAuth flow**: `401 → metadata → dynamic registration → browser auth → callback → token`

**SSO Proxy Plugin (priority 3) adds:**
- URL rewriting: `/mcp_auth?original=<url>` for initial connections; `/mcp_relay/<root_b64>/<relay_b64>/<path>` for relayed requests
- Replaces `client_name` in Dynamic Client Registration with `MCP_CLIENT_NAME`
- Rejects private/loopback origins (hostname + DNS) — SSRF protection
- Per-flow origin scoping to prevent cross-flow confusion

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MCP_CLIENT_NAME` | `CodeMie CLI` | OAuth registration name |
| `MCP_PROXY_DEBUG` | unset | Verbose proxy logging |
| `CODEMIE_PROXY_PORT` | auto | Fixed proxy port |

---

## Codex Cost & Metrics

Codex uses two pipelines (same model as Claude). Cost computed server-side; CLI never sends `money_spent`.

**Pipeline A — CLI tool/lifecycle → `POST /v1/metrics`**
- Tool deltas: `file:src/agents/plugins/codex/session/processors/codex.metrics-processor.ts` (keyed by `call_id`)
- Lifecycle: `file:src/agents/plugins/codex/codex.plugin.ts` (`onSessionStart`/`onSessionEnd`) → `processEvent` in `file:src/cli/commands/hook.ts:170-228`
- `status` hardcoded `'completed'`; end signal travels in `reason` field. Stale sessions → `reason: 'interrupted'`.

**Pipeline B — LLM proxy traffic → `codemie_litellm_proxy_usage`**
- Traffic routed through `CODEMIE_BASE_URL` via `model_providers.codemie` block: `file:src/agents/plugins/codex/codex.plugin.ts:222-281`
- Headers injected per request: `file:src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:30-83`
- Backend computes cost from `cost_config`; analytics joins pipelines by `session_id`.

**Stale-session reconciliation**: On every `onSessionStart`, `reconcileStaleCodexSessions` scans `~/.codemie/sessions/` for `status: "active"` sessions idle > 30 min and synthesises `SessionEnd` with `reason: 'interrupted'`. `file:src/agents/plugins/codex/codex.reconciliation.ts`

---

## Codex Model Resolution

Codex-desktop picks its model by a fixed precedence: **explicit `--model` flag > active profile `config.model` > recency-ranked default deployment**. The profile/undated picker name (e.g. `gpt-5.6-luna`) is resolved to its dated deployment via `resolveCodexDeployment`, never matched literally.

- **Connect-time** — `selectCodexModel(discovered, requested?, profileModel?)` writes the pinned model into `~/.codex/config.toml`. An explicit `--model` resolves-or-throws; otherwise the profile model is resolved and used, dropping to `discovered[0]` when it has no Codex equivalent. `file:src/cli/commands/proxy/connectors/codex-desktop.ts:182`
- **Request-time fallback** — the proxy normalizer's `resolveFallbackModel` substitutes the resolved profile model for an unmatched in-flight request, else the recency default. `file:src/providers/plugins/sso/proxy/plugins/codex-request-normalizer.plugin.ts:217`
- **Non-Codex profile models are ignored, never pinned.** An Anthropic/Sonnet profile model (e.g. `claude-sonnet-5`) is filtered by `isCodexServableDeployment` and resolves to `unresolved`, so it falls back to a Codex deployment rather than being written into a Codex request — and connect-time does **not** throw for it (only an explicit `--model` throws). `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts:89`, `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts:134`
- **Daemon lifecycle keys on the model.** `normalizeDaemonModel` feeds `daemonMatchesRequest`, so a changed profile model against an otherwise-matching live daemon **forces a restart** rather than reusing the stale one. `file:src/cli/commands/proxy/connect-orchestrator.ts:126`, `file:src/cli/commands/proxy/connect-orchestrator.ts:144`

The pure resolver in `codex-model-resolver.ts` is intentionally self-contained: the proxy must not depend on the Codex agent plugin.

---

## Claude Session Processing

`ConversationsProcessor` transforms raw JSONL transcript messages from a Claude Code session into conversation-log turns and syncs them to a per-session JSONL file. The processor is invoked on every `Stop` and `SessionEnd` hook event.

### Drain Loop

Claude Code's `Stop` hook fires only when the assistant responds. A burst of `!bash` commands with no assistant reply produces zero `Stop` events; without a drain loop those turns are lost before `SessionEnd` finalises the transcript. `processMessages` therefore iterates `transformMessages` in a bounded loop rather than calling it once per hook event.

| Invariant | Rule |
|---|---|
| Hard iteration cap | `Math.max(1, session.messages.length + 1)` — prevents unbounded loops if `transformMessages` regresses |
| Empty-history exit | Loop breaks immediately when `transformMessages` returns `history: []` |
| Advance guard | Loop breaks if `lastProcessedMessageUuid` and `currentHistoryIndex` are both unchanged from the previous iteration |

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:128-156`

### Per-Iteration Sync Checkpoint

After each successful JSONL append, `SessionStore.saveSession()` persists the updated sync pointer to session metadata. A crash mid-drain cannot cause the next invocation to re-append already-written turns; the final `applyProcessingSyncUpdates` pass is idempotent for the same fields.

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:189-211`

### Bash Passthrough Contract

Claude Code injects `!bash` commands as synthetic `type:'user'` messages. The processor must unwrap the command and filter all terminal-output messages so they do not consume turn slots.

| Raw transcript form | Handling |
|---|---|
| `<bash-input>cmd</bash-input>` | Unwrapped to `!cmd` by `extractCommand`; emits a `User` entry |
| `<bash-stdout>…` / `<bash-stderr>…` | Filtered by `isSystemMessage`; never consumes a turn slot |
| `<bash-input></bash-input>` (empty or whitespace) | Filtered; no bare `!` entry emitted |

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:667-688`, `856-871`

---

## skills.sh Wrapper (`codemie skills`)

Catalog-agnostic thin wrapper around the upstream `skills` npm CLI. Discovery, ranking, and source classification are out of scope for this CLI.

**Wrapper owns:**
- SSO auth gate before any subcommand
- Egress suppression (injects `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1`, `CI=1`, shim blocks `add-skill.vercel.sh`)
- Best-effort agent auto-detection (`--agent claude-code` if `.claude/` present; `--agent cursor` if `.cursor/` present)
- Lifecycle events POSTed to `<api-base>/v1/skills/events` (`started` / `completed` / `failed`); fan-out per skill when `--skill` lists multiple

**Wrapper does not own:** catalog browsing, source trust labels, alias resolution, parsing upstream output.

| File | Purpose |
|------|---------|
| `src/cli/commands/skills/index.ts` | Entry point |
| `assets/skills-sh-egress-guard.cjs` | Telemetry shim |
| `src/cli/commands/skills/lib/run-skills-cli.ts` | Spawn helper |
| `src/cli/commands/skills/lib/require-auth.ts` | Auth gate |
| `src/cli/commands/skills/lib/skills-metrics.ts` | Event emitter |
| `src/cli/commands/skills/lib/error-classify.ts` | Error classifier |

---

## Cursor Integration (analytics-only)

Cursor is read, never managed: `analyticsOnly: true`, no npm package, no CLI command, no provider
mapping. `codemie analytics` discovers Cursor Agent conversations from Cursor's local stores —
`state.vscdb` (`composerHeaders` for discovery, `cursorDiskKV` for per-turn enrichment),
`~/.cursor/projects/<slug>/agent-transcripts/`, and `~/.cursor/ai-tracking/ai-code-tracking.db` —
all read-only and all fail-soft. `CURSOR_HOME` relocates every one of them. Cursor sessions are
tagged `native-external` and appear only with `--include-external`.

**Recent Cursor builds write zero `tokenCount` on bubbles, or omit it, while `toolFormerData` still
works** — so tool-call enrichment is reliable and token/cost enrichment is usually empty. The
supported way to recover real Cursor tokens and cost is the **dashboard usage export**
(`--cursor-usage-csv <path>`, `src/agents/plugins/cursor/cursor.usage-csv.ts`) — a local file read
with no credential. `Kind=Included` in that CSV is a billing category, not zero usage: verified
export rows marked `Included` carried 39,952,466 tokens and $25.25. Team Analytics is **not** the
answer here and never was. Such
sessions carry `usageUnavailableReason` and render as an em dash, never as `$0`, `Included`, or
"covered by subscription". Do not widen the default discovery max-age to harvest year-old bubbles
that still have tokens, and do not infer tokens from `contextTokensUsed`, transcript length, or
tool-call counts. When tokens *are* recovered under an unpriceable model (`default`/Auto), the cost
enricher estimates at a published Claude Sonnet rate, preserves the original model label, and marks
the session `usagePartial`.

Full operational and developer guide: `docs/CURSOR_INTEGRATION.md`. Rationale for reading an
undocumented store: `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`.

### Cursor Enterprise Team Analytics API (not integrated)

Cursor publishes an official Team Analytics API
(<https://cursor.com/docs/account/teams/analytics-api>). CodeMie integrates it as a strictly
**CodeMie does not integrate it.** A complete, reviewed implementation exists on the
`feature/cursor-team-analytics-untested` branch and was deliberately kept off the shipping branch:
no one on the team has an enterprise-admin account, so the success path was never exercised
against the live API (every probe returned `401 Invalid Team API Key`). Shipping untestable code
that makes network calls is the risk being avoided — not a judgement that the code is wrong.

Two facts make this an easy trade. The API **cannot** supply tokens or cost at any tier, so it
never answered the question people actually have about Cursor; and its key is not obtainable by an
ordinary team member. The path that does work, for everyone, is the dashboard usage export via
`--cursor-usage-csv`.

If it is ever revived, the constraints below still hold, and the branch already implements them.

What the API is:

- **Enterprise-team-only** and gated on an **admin-scoped API key**. An individual user on a
  personal plan cannot use it at all.
- Documented endpoints: `agent-edits`, `tabs`, `dau`, `models`, `commands`,
  `conversation-insights`, `leaderboard`, `bugbot`.
- **None of these endpoints returns token or cost fields at any tier.** The API cannot fill
  CodeMie's biggest Cursor gap. Re-verified against the live docs on 2026-09-05: responses carry
  `total_suggested_diffs`, `total_accepted_diffs`, `total_rejected_diffs`,
  `total_green_lines_accepted`, `total_red_lines_accepted`, `total_suggestions`, `total_accepts`,
  `total_rejects`, `messages`, `command_name`, `skill_name`, `model` — and nothing token-shaped.

How the shipped integration honours the constraints below: it queries only `by-user` endpoints
(`agent-edits`, `tabs`, `models`, `commands`) with `users=<the report owner's own email>`, never a
`team/*` endpoint and never the leaderboard; it renders into its own "Cursor Team API" report view
that is hidden unless a pull happened; it synthesizes no token or cost field; and every failure
mode — missing key, HTTP error, DNS failure, schema drift — degrades to an omitted or partial
section rather than breaking the local report.

Agreed constraints for any future integration:

- **Trigger model.** A configured token alone must never enable network calls. Both the token
  *and* an explicit opt-in flag at invocation are required, mirroring how `--include-external`
  gates external sessions. Reading local files is a promise CodeMie already makes; calling a
  remote service is not, and must stay an explicit act.
- **Data scope.** User-wide only: the `by-user` endpoints filtered to the requesting user's own
  email. Not team-wide data, not the leaderboard. CodeMie analytics reports the operator's own
  usage, and pulling colleagues' activity into it is out of scope.
- **Unsolved reconciliation problem.** The API returns per-user/per-date aggregates with **no
  join key to a local `composerId`-keyed session**. There is therefore no way to enrich
  `ReportSessionRecord` rows with it. Any integration would have to render a **separate summary
  section**, clearly labelled as team-API data, rather than merging into the session table —
  attempting the merge would silently double-count or mis-attribute.

Full context: ADR 0001, [`docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`](../../../docs/adr/0001-cursor-session-discovery-from-state-vscdb.md).

## Configuration Validation

Validate provider config at startup; warn (not throw) on connectivity failures. `file:src/env/config-loader.ts:150-170`

| Check | Behavior |
|-------|----------|
| Missing API key | Throw `ConfigurationError` with env var name |
| Connectivity test fail | `logger.warn` only — don't block startup |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid API key" | Wrong/missing key | Check env var, regenerate |
| Rate limit errors | Too many requests | Add backoff, upgrade plan |
| SSO auth fails | Expired token | `codemie setup` to refresh |
| AWS auth fails | Missing credentials | Configure AWS CLI or set env vars |
| LiteLLM connection error | Proxy not running | `litellm --port 4000` |
| OpenCode not found | Not installed | `codemie install opencode` |
| OpenCode sessions not syncing | Metrics processing failed | `codemie opencode-metrics --discover --verbose` |
| No Cursor sessions in analytics | Cursor sessions are external | Re-run with `--include-external`; see `docs/CURSOR_INTEGRATION.md` |
| Codex sessions stuck `status: active` | Hard kill skipped `onSessionEnd` | Auto-reconciled on next codex run via `codex.reconciliation.ts` |
| Codex `money_spent` is 0 | Backend `cost_config` missing model entry | Add model pricing in backend `cost_config` |

---

## References

- Provider plugins: `src/providers/plugins/`
- Provider core types: `src/providers/core/types.ts`
- OpenCode plugin: `src/agents/plugins/opencode/`
- Codex plugin: `src/agents/plugins/codex/`
- Claude plugin: `src/agents/plugins/claude/`
- Cursor plugin: `src/agents/plugins/cursor/` (guide: `docs/CURSOR_INTEGRATION.md`, ADR: `docs/adr/0001-cursor-session-discovery-from-state-vscdb.md`)
- MCP proxy: `src/mcp/`
- Session adapters: `src/agents/core/session/`
- Config loader: `src/env/config-loader.ts`
- Related guide: `.ai-run/guides/architecture/architecture.md`
