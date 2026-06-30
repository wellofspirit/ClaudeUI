# Follow-up — opencode custom-agent CRUD, slice C1 (backend: service + generate + IPC)

> Kickoff spec. Agent: **Sonnet, `general-purpose`**. Opus orchestrates, reviews every line, runs gates,
> commits. **You must NOT:** commit, `git add`, branch, `bun install`/`add`/`remove`, or self-certify.
> Leave the tree dirty for review. `gray-matter@4.0.3` is **already installed** — just import it.
> Decisions are fixed in **[ADR-029](../adr/adr-029_opencode-custom-agent-crud.md)** — read it first.

This is the **backend slice** of the custom-agent CRUD. NO renderer/UI work (that's slice C2). Build the
main-process agent service, the AI-generate helper, and the IPC/preload surface, with tests.

## 0. What we're building
Full CRUD over opencode agents stored as **markdown files** in opencode's own dirs (ADR-028/029):
- global `~/.config/opencode/agents/<name>.md`, project `<cwd>/.opencode/agents/<name>.md`.
- frontmatter (gray-matter) = fields; markdown body = system prompt.
- built-ins are overridable (same-named override file); disable via `disable: true`.
- permissions are OPT-IN (a `permission` block only when the user restricts the agent).
- an AI-generate helper drafts `{identifier, whenToUse, systemPrompt}` from a one-line description.

## 1. Verified facts (file:line; do NOT re-discover)
- **Global config dir** already resolved by `opencodeConfigDir()` in `src/main/opencode/opencode-config.ts`
  (`OPENCODE_CONFIG_DIR` → `XDG_CONFIG_HOME` → `~/.config`, `+ /opencode`). **Reuse it.** Agents dir =
  `<configDir>/agents`. Project dir = `<cwd>/.opencode/agents`.
- **opencode discovers** agents via glob `{agent,agents}/**/*.md` (vendor `config/agent.ts`): filename =
  agent name; frontmatter = data; body = `prompt`. `opencode agent create` writes to the **plural**
  `agents/` dir (vendor `cli/cmd/agent.ts`) with frontmatter `{ description, mode, permission? }` + body.
  ⇒ For READS scan both `agent/` and `agents/`; for WRITES use `agents/`.
- **Built-in agents** (vendor `agent/agent.ts`): primary `build`, `plan`; subagent `general`, `explore`;
  hidden `title`, `summary`, `compaction`. Overridable by a same-named entry; `disable:true` removes one.
- **gray-matter** (what opencode uses): `import matter from 'gray-matter'`. `matter(text)` →
  `{ data, content }`; `matter.stringify(body, data)` → file text with `---` YAML frontmatter.
- **AI-generate transport**: mirror the auto-mode judge runner `OpencodeSession.makeJudgeFn`
  (`OpencodeSession.ts:990-1010`): `opencodeServerManager.acquire(cwd)` → `new OpencodeClient(baseUrl,
  authHeader)` → `client.createSession({title})` → `client.prompt(id, {...})` → parse text →
  `client.deleteSession(id)` + `release(cwd)`. `model-discovery.ts` shows the acquire/release +
  `PERSISTED_SESSIONS_DIR` fallback when there's no active cwd.
- **The meta-prompt** to port: `vendor/opencode-src/packages/opencode/src/agent/generate.txt` (the
  "elite AI agent architect" prompt). Output schema it asks for: a JSON object
  `{ identifier: string, whenToUse: string, systemPrompt: string }`.
- **Existing `OpencodeClient`** has `createSession`, `prompt`, `deleteSession` (`OpencodeClient.ts:133,156,175`).

## 2. The work

### 2a. NEW `src/main/opencode/opencode-agents.ts` — the CRUD service
Types (export):
```ts
type OpencodeAgentScope = 'global' | 'project'
type OpencodeAgentMode = 'primary' | 'subagent' | 'all'
interface OpencodeAgentSummary { name; kind:'custom'|'builtin'; mode:OpencodeAgentMode; scope:OpencodeAgentScope|null;
  model?:string; color?:string; overridden?:boolean; disabled?:boolean; hidden?:boolean }
interface OpencodeAgentDetail extends OpencodeAgentSummary { description?:string; prompt?:string;
  temperature?:number; topP?:number; steps?:number; reasoningEffort?:string;
  restrict:boolean; permission?:Record<string,'allow'|'ask'|'deny'> }
interface OpencodeAgentInput { name; scope:OpencodeAgentScope; mode; model?; description?; prompt?;
  temperature?; topP?; steps?; reasoningEffort?; color?; hidden?; disable?;
  permission?:Record<string,'allow'|'ask'|'deny'> }  // permission present ⇔ restrict on
```
Functions (pure where possible; isolate fs):
- `BUILTIN_AGENTS`: the registry above (name → default mode, hidden?).
- `agentsDirs(cwd?)`: `{ global: <configDir>/agents, project: cwd ? <cwd>/.opencode/agents : null }`.
- `listAgents(cwd?): OpencodeAgentSummary[]` — scan global+project (`agent/` and `agents/`, `*.md`), parse
  frontmatter for summary fields; classify name as builtin vs custom; then add any BUILTIN not present as a
  file (kind builtin, scope null, overridden:false). For built-ins WITH a file → `overridden:true`,
  `disabled = data.disable===true`. Sort: custom first then built-in, alpha within.
- `readAgent(name, scope, cwd?): OpencodeAgentDetail | null` — read the scope's file; map frontmatter →
  detail (`top_p`→topP, `options.reasoningEffort`→reasoningEffort, `permission`→permission with
  `restrict = !!permission`), body→prompt. For a built-in with no file return a default detail
  (kind builtin, restrict:false, prompt undefined).
- `saveAgent(input): void` — build frontmatter object: `description, mode, model?, temperature?, top_p?(from topP),
  steps?, options?({reasoningEffort} when set), color?, hidden?(only if true), disable?(only if true),
  permission?(only when input.permission has keys)`. Omit unset keys. `matter.stringify(input.prompt ?? '',
  frontmatter)`; `mkdir -p` the scope's `agents/` dir; write `<name>.md`.
- `deleteAgent(name, scope, cwd?): void` — remove the `<name>.md` from the scope's `agent/`+`agents/` dirs
  (custom = delete; built-in = "reset to default").
- `setAgentDisabled(name, scope, cwd?, disabled): void` — read-merge the scope file's frontmatter, set/clear
  `disable`, re-stringify preserving body (for a built-in with no file, create one with just `disable:true`).
- Keep the **fs** in thin wrappers and the **mapping** (frontmatter↔detail, input↔frontmatter, builtin merge)
  as pure functions so they're unit-testable without disk. Honor `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` so
  tests can point at a tmp dir.

### 2b. NEW `src/main/opencode/agent-generate.ts` — AI-assisted authoring
- Port the meta-prompt: copy `generate.txt` verbatim into a `const AGENT_GENERATE_PROMPT` (or a sibling
  `.txt` imported as a string). Do NOT paraphrase.
- `generateAgent(description: string, cwd?: string): Promise<{ identifier:string; whenToUse:string; systemPrompt:string }>`
  — acquire a server for `cwd ?? PERSISTED_SESSIONS_DIR`, `createSession` → `prompt` with system =
  AGENT_GENERATE_PROMPT, user = ``Create an agent configuration based on this request: "${description}". Return ONLY the JSON object, no backticks.`` → extract the assistant text → `JSON.parse` (strip ```/```json fences defensively) → validate the three string fields → `deleteSession` + `release`. Throw on parse/validation failure (caller surfaces a soft error). Mirror `makeJudgeFn`'s client usage + the model resolution (session default model).

### 2c. IPC + preload
- `session.ipc.ts`: register `opencode-agents:list|read|save|delete|set-disabled|generate` with `safeHandler`;
  add all six channel strings to `SESSION_IPC_CHANNELS` (mirror the opencode-settings handlers from ADR-028).
- `preload/index.ts` + `shared/types.ts` `SessionAPI`: add the six methods (use `unwrap` like the
  opencode-settings pair). Stub them in `web/api-adapter.ts` (desktop-only) and `test/helpers/boot-test-app.ts`.

## 3. Tests (`opencode-agents.test.ts`, `agent-generate.test.ts`; node project)
- Path resolution honours `OPENCODE_CONFIG_DIR` (tmp dir); agents dir = `<dir>/agents`.
- list: built-ins always present; a custom `*.md` shows as custom; a built-in override file → `overridden`;
  `disable:true` → `disabled`. project + global both scanned.
- read→save **round-trip**: fields map both ways; `topP`↔`top_p`; reasoningEffort↔`options.reasoningEffort`;
  body↔prompt; **permission present ⇔ restrict** (no `permission` key when not restricted).
- save omits unset keys (no empty `permission`, no `hidden:false`); writes to `agents/` (plural).
- delete removes the file; setAgentDisabled toggles `disable` preserving the body + other frontmatter.
- generate: mock the OpencodeClient prompt to return a JSON string (and a fenced variant) → parsed object;
  malformed → throws.

## 4. Verify gates (report exact output; do NOT commit)
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
0 lint errors (the 2 exhaustive-deps warnings are pre-existing; the model-discovery tests are GREEN now —
if any fail, that's a regression, investigate). No `bun install`. Leave tree dirty; list changed files +
rationale + deviations. No app-shot (orchestrator drives the app). rm any throwaway probe scripts.

## 5. Gotchas
- **Reuse `opencodeConfigDir()`** from opencode-config.ts — do not re-implement the path logic.
- **Write to `agents/` (plural), read both `agent/` and `agents/`** — match opencode's discovery + create.
- **Permission opt-in** — only emit a `permission` frontmatter block when the user restricted the agent;
  default agents have NO permission block (they inherit the session autonomy mode — ADR-029).
- **gray-matter** parse can throw on malformed YAML — wrap reads in try/catch, skip unparseable files in list.
- **Generate is best-effort** — never block; surface errors to the caller for a soft UI message.
- **Don't touch** the renderer (slice C2), permissions engine, or Phase-A/B code beyond importing helpers.
