# Multi-engine architecture & auth

Part of [architecture/](README.md).

## Multi-engine architecture

The V2 model (ADR-018) separates **Engine** (harness: `claude` | `opencode` | `pi`) × **Vendor** (model maker) × **Account** (billing/auth identity). `ModelRef {engineId, vendorId, modelId}` is the universal selection/persistence key; `engineId` is immutable per session, model/account/capabilities re-resolve on model switch.

- **Session seam** — `src/main/providers/`: all backends implement `ISession`; `SessionManager` holds `Map<routingId, ISession>`; the renderer consumes the same `session:*` events regardless of engine. `SpawnPrepRegistry` applies per-engine spawn env (unknown engine throws). `shared/engine-meta.ts` is the per-engine descriptor table — adding an `EngineId` is a compile error until its meta exists.
- **Capabilities** — `EngineCapabilities` × `ModelCapabilities` → `ResolvedCapabilities` (`shared/model-capabilities.ts`), recomputed on session start and model switch; the renderer gates every feature on it. Per ADR-030, a flag is only `true` when the full end-to-end path works.
- **opencode backend** (ADR-019) — a shared, ref-counted `opencode serve` per cwd (HTTP + SSE `/event`, v1 API, Basic auth); `OpencodeSession` maps events to the neutral ContentBlock/`session:*` contract in `event-mapper.ts`. Permissions compile autonomy modes to opencode rulesets (ADR-022); auto mode uses an LLM judge (ADR-023); interaction parity (slash/skills, questions, queue/steer, subagents) per ADR-024; engine-native config is written to opencode's own files, diff-driven (ADR-028/031); custom agents per ADR-029; tool-experience parity per ADR-032.
- **pi backend** (ADR-035) — a `pi --mode rpc` child process per session (LF-framed JSONL over stdio, no server — the claude-shaped lifecycle); `PiSession` maps events to the neutral contract in `src/main/pi/event-mapper.ts`. pi has no native permissions and no MCP client, so a ClaudeUI-owned `-e` bridge extension (`pi-bridge-source.ts`) POSTs `tool_call` decisions to a per-session loopback `PiBridgeHost` (evaluated by the pure `permission-engine.ts` against the SAME `~/.claude` rules Claude/opencode use — ADR-022 parity), and registers the hosted tools + `dispatch_agent` via `pi.registerTool()` over the same host. Auth reads/writes pi's own `auth.json` (ADR-021); shared skills via the extension's `resources_discover`. Details + verified wire facts: `docs/protocol-pi/`.
- **Cross-engine dispatch** (ADR-033) — a hosted `dispatch_agent` tool lets a session on any engine delegate to a headless target on another, with subtask-style TaskCard streaming, forwarded approvals, cost cap, and usage attributed to the dispatching session. pi participates both directions (ADR-035): as a source via a `registerTool` dispatch tool, as a target via a headless `PiRpcClient` + per-target `PiBridgeHost` (recursion structurally impossible — a target's child never gets the dispatch tool).
- **Tool rendering** — engine tool names map to a neutral `ToolKind` taxonomy (`shared/tool-kinds.ts`); kind bodies under `renderer/.../tool-registry/kinds/` consume an engine-neutral `ToolView`. The per-engine `kindOf` switches in `ClaudeEngineToolMap.ts` / `OpencodeEngineToolMap.ts` / `PiEngineToolMap.ts` are the canonical mapping tables.

## Auth / accounts

`EngineAuthProvider` (`src/main/auth/`, ADR-021) is the per-engine auth abstraction with capability-gated method groups: `probe()` (always), sign-in driving (`canDriveLogin`), and account CRUD (`multiAccount`).

- **`ClaudeAuthProvider`** wraps `AuthManager` + `AccountManager`: native OAuth rides cli.js control requests on the service session (ADR-014); multi-account uses per-account file credentials via the `skip-securestorage` patch (ADR-015). `probe()` derives auth state from the cached `session:auth-source` signal — **no credential-file reads** (avoids Keychain prompts). Account metadata lives in the DB (`account` table); the `enabled`/`activeId` pointer stays in `accounts.json`; credentials stay file-based, never in the DB.
- **`OpencodeAuthProvider`** probes by merging `/config/providers` + `/provider/auth`; per-vendor API-key and OAuth flows via `vendor-auth:*` IPC (opencode owns `auth.json`).
- `session.account: AccountRef | null` rides every `SessionStatus`; `AuthState` is the tri-state `'authenticated' | 'unauthenticated' | 'unknown'`, while the login-flow object is `AuthFlowState`.

Remote-access authentication (tokens, passwords, tailnet identity, and the target passkey model) is a separate concern: [security.md](security.md) and ADR-039/052.
