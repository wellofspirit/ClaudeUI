# 02 — CLI flags

Every flag cli.js accepts. Verified against 2.1.114. Commander builder `Ft1` at char `12942893`; action handler at `~12953900`; pre-parse at `12940601`. Permission-mode enum `bG`/`g6H` at char `1007993`.

Flags split into two categories:
- **Shown** — `.option(long, desc, ...)` in Commander, appears in `--help`.
- **Hidden** — `.addOption(new l7(...).hideHelp())`, not in `--help` but still parsed.

Pre-parse argv scan at char `12940601` (`Bt1`) intercepts `--handle-uri`, `-p`, `--init-only`, `--sdk-url` BEFORE Commander runs, to disable TTY/banner machinery.

---

## 2.1 Output & I/O

### `--output-format <format>`
- **Type:** enum: `text` | `json` | `stream-json`
- **Default:** `text`
- **Effect:** Under `-p/--print`, selects stdout wire format. `text` = final assistant text only. `json` = single result envelope after the run. `stream-json` = line-delimited SDK events in real time (ClaudeUI mode).
- **Validation:** `--input-format=stream-json` requires `--output-format=stream-json`. `--output-format=stream-json` with `--print` requires `--verbose`.
- **Anchors:** parseOpt `12945646`, validation `12963885`.

### `--input-format <format>`
- **Type:** enum: `text` | `stream-json`
- **Default:** `text`
- **Effect:** Selects stdin parsing when `--print` is set. `stream-json` expects line-delimited SDK user messages on stdin (multi-turn streaming). Anything else hard-errors.
- **Anchors:** parseOpt `12946000`, validation `12963830`.

### `--verbose`
- **Type:** boolean
- **Default:** follows `V$().viewMode` / `Y8().briefTranscript` from config
- **Effect:** Overrides verbose setting from saved config. REQUIRED when combining `--print` + `--output-format=stream-json`.
- **Anchors:** parseOpt `12945830`, applied `12955617`, error `12821802`.

### `-d, --debug [filter]`
- **Type:** optional-value string
- **Default:** unset → off. With no value: all categories. With value: category filter (comma-list, `!` prefix excludes, aliases like `1p`, `file`).
- **Effect:** Debug logging pipeline.
- **Anchor:** parseOpt `12945350`.

### `-d2e, --debug-to-stderr` (hidden)
- **Type:** boolean
- **Default:** false
- **Effect:** Same as `--debug` but forces stderr output regardless of TTY/file sinks.
- **Anchor:** parseOpt `12945450`.

### `--debug-file <path>`
- **Type:** string
- **Default:** none
- **Effect:** Writes debug logs to file. Implicitly enables debug mode.
- **Anchor:** parseOpt `12945630`.

### `--include-hook-events`
- **Type:** boolean
- **Default:** false
- **Effect:** With stream-json, forwards every hook lifecycle event as `system/hook_started|hook_progress|hook_response`. Env fallback: `CLAUDE_CODE_REMOTE` truthy also enables.
- **Anchor:** parseOpt `12946140`; wired `12955740`.

### `--include-partial-messages`
- **Type:** boolean
- **Default:** false
- **Effect:** Emits `stream_event` deltas (per-token streaming) alongside `assistant` messages. Env fallback: `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES`. Requires `--print` + `--output-format=stream-json`.
- **Anchors:** parseOpt `12946280`, env `12955783`, validation `12964165`.

### `--session-mirror` (hidden)
- **Type:** boolean
- **Default:** false
- **Effect:** Emits `transcript_mirror` frames on stdout so external session stores can reconstruct the transcript. SDK-internal.
- **Anchor:** parseOpt `12946430`.

### `--replay-user-messages`
- **Type:** boolean
- **Default:** false
- **Effect:** Echoes stdin user messages back on stdout as acks. Requires `--input-format=stream-json` AND `--output-format=stream-json`.
- **Anchors:** parseOpt `12948430`, validation `12964015`.

### `--enable-auth-status` (hidden)
- **Type:** boolean
- **Default:** false
- **Effect:** Pushes `auth_status` messages into the stream. **This is the real gate** — the initialize payload's `enableAuthStatus` field is a silent no-op; use this CLI flag instead.
- **Anchor:** parseOpt `12948580`.

### `--json-schema <schema>` (hidden)
- **Type:** JSON string
- **Default:** none
- **Effect:** Structured output schema. Under `--print` non-interactive mode, builds a structured-output tool. Triggers `tengu_structured_output_enabled` telemetry.
- **Anchors:** parseOpt `12945870`, consumed `12963710`, registered `12964690`.

---

## 2.2 Prompt / session control

### `[prompt]` (positional)
- **Type:** string
- **Default:** none (reads stdin / opens TTY)
- **Effect:** Initial user prompt. Literal `"code"` prints a tip + clears (`tengu_code_prompt_ignored`). Single-word non-flag prompts without `--print`/`--continue`/`--resume` matching `/^[a-zA-Z][a-zA-Z-]*$/` trigger interactive slash-command/skill resolution.
- **Anchor:** `12955478`.

### `-p, --print`
- **Type:** boolean
- **Default:** false
- **Effect:** Non-interactive mode: run prompt, print, exit. Disables trust dialog. Gates many other flags: `--output-format`, `--input-format`, `--include-*`, `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--permission-prompt-tool`, `--resume-session-at`, `--workload`, `--no-session-persistence`.
- **Anchors:** parseOpt `12945685`, pre-parse `12941020`.

### `--bare`
- **Type:** boolean
- **Default:** false
- **Effect:** Minimal-mode launch. Sets `CLAUDE_CODE_SIMPLE=1`. Skips: hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, `CLAUDE.md` auto-discovery. Anthropic auth restricted to `ANTHROPIC_API_KEY` or `apiKeyHelper` from `--settings`. 3P providers still use their credentials. Skills still resolve via `/skill-name`.
- **Anchors:** parseOpt `12945940`, applied `12955320`.

### `--init` (hidden)
- **Type:** boolean
- **Effect:** Runs Setup hooks with `init` trigger, then continues into normal session.
- **Anchor:** parseOpt `12946880`.

### `--init-only` (hidden)
- **Type:** boolean
- **Effect:** Runs Setup + `SessionStart:startup` hooks, then exits. Pre-parse treats like `--print`.
- **Anchors:** parseOpt `12946950`, pre-parse `12941050`.

### `--maintenance` (hidden)
- **Type:** boolean
- **Effect:** Runs Setup hooks with `maintenance` trigger, then continues.
- **Anchor:** parseOpt `12947020`.

### `-c, --continue`
- **Type:** boolean
- **Effect:** Resume the most recent conversation in the current directory. Mutually guarded with `--session-id` unless `--fork-session` is also set.
- **Anchors:** parseOpt `12947880`, guard `12957730`.

### `-r, --resume [value]`
- **Type:** optional-value string (session UUID, or search term; bare flag opens picker)
- **Effect:** With UUID → resumes it. With string → fuzzy search via `vx()`; single match resumes; otherwise picker seeded with the string.
- **Anchors:** parseOpt `12947920`, resolution `12979058`.

### `--fork-session`
- **Type:** boolean
- **Effect:** On resume, allocate a fresh session UUID instead of reusing. Required when combining `--session-id` with `--continue`/`--resume`.
- **Anchor:** parseOpt `12948075`.

### `--from-pr [value]`
- **Type:** optional-value string (PR number/URL; empty → picker)
- **Effect:** Resume a session linked to a PR by number/URL.
- **Anchors:** parseOpt `12948840`, resolved `12978935`.

### `--no-session-persistence`
- **Type:** boolean (Commander negation → `sessionPersistence=false`)
- **Default:** persistence enabled
- **Effect:** Don't write session transcript to disk; not resumable. Restricted to `--print`.
- **Anchors:** parseOpt `12948990`, validation `12964265`.

### `--resume-session-at <message-id>` (hidden)
- **Type:** string (assistant message ID)
- **Effect:** Under `--print --resume`, include messages only up to and including the given assistant message.
- **Anchor:** parseOpt `12949100`.

### `--rewind-files <user-message-id>` (hidden)
- **Type:** string
- **Effect:** Restore working-tree files to state at given user message, then exit. Requires `--resume`.
- **Anchor:** parseOpt `12949330`.

### `--session-id <uuid>`
- **Type:** string (UUID v4)
- **Default:** auto-generated
- **Effect:** Force specific session UUID. Without `--fork-session`, UUID must not already be in use.
- **Anchors:** parseOpt `12950290`, validation `12957810`.

### `--prefill <text>` (hidden)
- **Type:** string
- **Effect:** Pre-fills the interactive prompt box (does not submit).
- **Anchors:** parseOpt `12948200`, applied `12955564`.

### `--prefill-b64 <b64>` (hidden)
- **Type:** string (base64url UTF-8)
- **Effect:** Shell-safe `--prefill`. Decoded via `Buffer.from(Y,"base64url").toString("utf8")`. Promoted into `O.prefill` only when `--deep-link-origin` is set.
- **Anchors:** parseOpt `12948500`, promotion `12955070`.

### `--deep-link-origin` (hidden)
- **Type:** boolean
- **Effect:** Marker that the session was launched from a deep link. Gates `--prefill-b64` → `--prefill` + `--deep-link-cwd-b64` → `chdir()` promotions.
- **Anchor:** parseOpt `12948240`.

### `--deep-link-repo <slug>` (hidden)
- **Type:** string (`owner/repo`)
- **Effect:** Repo slug the deep link `?repo=` resolved to. Surfaces in startup banner.
- **Anchors:** parseOpt `12948300`, banner `12984430`.

### `--deep-link-last-fetch <ms>` (hidden)
- **Type:** number (epoch ms)
- **Effect:** `FETCH_HEAD` mtime from trampoline.
- **Anchor:** parseOpt `12948380`.

### `--deep-link-cwd-b64 <b64>` (hidden)
- **Type:** string (base64url UTF-8 path)
- **Effect:** Shell-safe cwd. With `--deep-link-origin`, `process.chdir()` + rebuild caches.
- **Anchors:** parseOpt `12948620`, applied `12955130`.

### `-n, --name <name>`
- **Type:** string
- **Effect:** Display name for the session (prompt box, `/resume` picker, terminal title via `UO$`).
- **Anchors:** parseOpt `12950480`, applied `12956630`.

---

## 2.3 System prompt / agent overrides

### `--system-prompt <prompt>`
- **Type:** string
- **Effect:** Replaces the default system prompt entirely. Mutually exclusive with `--system-prompt-file`. Disables `--exclude-dynamic-system-prompt-sections` optimization.
- **Anchors:** parseOpt `12947130`, merge `12956740`.

### `--system-prompt-file <file>` (hidden)
- **Type:** string (file path)
- **Effect:** Reads system prompt from disk. ENOENT → clean error.
- **Anchors:** parseOpt `12947260`, file read `12956770`.

### `--append-system-prompt <prompt>`
- **Type:** string
- **Effect:** Appends to default system prompt (rather than replacing).
- **Anchor:** parseOpt `12947410`.

### `--append-system-prompt-file <file>` (hidden)
- **Type:** string (file path)
- **Effect:** Reads appended prompt from file. Mutually exclusive with `--append-system-prompt`.
- **Anchors:** parseOpt `12947530`, file read `12958910`.

### `--exclude-dynamic-system-prompt-sections`
- **Type:** boolean
- **Effect:** Moves per-machine sections (cwd, env, memory paths, git status) from system prompt into the first user message. Improves cross-user prompt-cache reuse. No-op if `--system-prompt` is set.
- **Anchor:** parseOpt `12947740`.

### `--agents <json>`
- **Type:** string (JSON object literal)
- **Effect:** Custom agents inline. Example: `'{"reviewer": {"description":"...","prompt":"..."}}'`.
- **Anchors:** parseOpt `12950580`, consumed `12956590`.

### `--agent <agent>`
- **Type:** string (agent name)
- **Effect:** Selects active custom agent. Overrides settings.json `agent`.
- **Anchors:** parseOpt `12950010`, resolution `12956595`.

### `--advisor <model>` (hidden, feature-gated)
- **Type:** string (model alias or full ID)
- **Effect:** Enables server-side advisor tool with specified model. Only when `vu()` truthy.
- **Anchor:** parseOpt `12984175`.

---

## 2.4 Tools & permissions

### `--allowedTools, --allowed-tools <tools...>`
- **Type:** repeatable string (space/comma-separated)
- **Default:** `[]`
- **Effect:** Explicit allow-list. Rules: `Bash(git *)`, `Edit`, etc.
- **Anchors:** parseOpt `12949830`, consumed `12955555`.

### `--disallowedTools, --disallowed-tools <tools...>`
- **Type:** repeatable string
- **Default:** `[]`
- **Effect:** Deny-list. Deny beats allow.
- **Anchor:** parseOpt `12949980`.

### `--tools <tools...>`
- **Type:** repeatable string
- **Default:** built-in default set
- **Effect:** Controls set of available built-in tools. `""` → all disabled. `"default"` → all. Else explicit list (e.g., `"Bash,Edit,Read"`).
- **Anchor:** parseOpt `12949890`.

### `--permission-mode <mode>`
- **Type:** enum: `acceptEdits` | `auto` | `bypassPermissions` | `default` | `dontAsk` | `plan`
- **Default:** config-resolved (`default`)
- **Effect:**
  - `bypassPermissions` — skips all prompts
  - `acceptEdits` — auto-allows file writes
  - `plan` — restricts to plan-mode tools
  - `auto` — runs through auto-mode classifier
  - `dontAsk` — treats unmatched as deny
  - `default` — prompt-on-unmatched
- **Interactions:** `CLAUDE_CODE_REMOTE` restricts to `acceptEdits` + `plan`. Sets global `N76(BH === "bypassPermissions")`.
- **Anchors:** parseOpt `12947780`, resolution `12959100` (`k9$()`). Enum source: `1007993` (`g6H`).

### `--permission-prompt-tool <tool>` (hidden)
- **Type:** string (MCP tool `mcp__server__tool`)
- **Effect:** MCP tool invoked for approve/deny decisions instead of interactive prompt. `--print`-only.
- **Anchor:** parseOpt `12946970`.

### `--dangerously-skip-permissions`
- **Type:** boolean
- **Effect:** Bypass all permission checks. Sets telemetry `dangerouslySkipPermissionsPassed`, triggers `modeIsBypass`.
- **Anchors:** parseOpt `12946770`, `12959100`.

### `--allow-dangerously-skip-permissions`
- **Type:** boolean
- **Effect:** Enables the bypass-permissions toggle in UI without flipping it on. Tracked separately (`allowDangerouslySkipPermissionsPassed`).
- **Anchor:** parseOpt `12946900`.

### `--thinking <mode>` (hidden)
- **Type:** enum: `enabled` | `adaptive` | `disabled` (`enabled` equivalent to `adaptive`)
- **Default:** config-resolved
- **Effect:** Extended-thinking control. `adaptive` lets model self-select depth.
- **Anchor:** parseOpt `12947820`.

### `--thinking-display <display>` (hidden)
- **Type:** enum: `summarized` | `omitted`
- **Default:** config-resolved
- **Effect:** How thinking blocks appear in response. `omitted` hides them.
- **Anchor:** parseOpt `12947940`.

### `--max-thinking-tokens <tokens>` (hidden, DEPRECATED)
- **Type:** integer
- **Effect:** Legacy cap. Deprecated for `--thinking`. `--print`-only.
- **Anchor:** parseOpt `12948070`.

### `--max-turns <turns>` (hidden)
- **Type:** integer
- **Effect:** Early-exit after N agentic turns. `--print`-only.
- **Anchor:** parseOpt `12948200`.

### `--max-budget-usd <amount>` (hidden)
- **Type:** number (USD, positive)
- **Effect:** Cap spending. Rejects non-positive with `"--max-budget-usd must be a positive number greater than 0"`. `--print`-only.
- **Anchor:** parseOpt `12948380`.

### `--task-budget <tokens>` (hidden)
- **Type:** positive integer
- **Effect:** Maps to API-side `output_config.task_budget`. Rejects non-integers/non-positives.
- **Anchor:** parseOpt `12948600`.

### `--effort <level>` (hidden)
- **Type:** enum: `low` | `medium` | `high` | `xhigh` | `max`
- **Default:** config-resolved
- **Effect:** Session-wide effort knob. Rejects unknown levels.
- **Anchor:** parseOpt `12949700`.

---

## 2.5 Model & auth overrides

### `--model <model>`
- **Type:** string (alias `sonnet`/`opus` or full id like `claude-opus-4-7`)
- **Default:** config-resolved (`UW()`), falls back to `ANTHROPIC_MODEL` env
- **Effect:** Main-session model. `"default"` → `UW()`.
- **Anchors:** parseOpt `12949530`, resolution `12956590`.

### `--fallback-model <model>`
- **Type:** string
- **Effect:** Auto-fallback on overloaded primary. `--print`-only. Rejects `--fallback-model === --model`.
- **Anchors:** parseOpt `12950070`, guard `12956710`.

### `--betas <betas...>`
- **Type:** repeatable string
- **Default:** `[]`
- **Effect:** Beta headers for API requests (API-key users only). Becomes `anthropic-beta:` headers.
- **Anchor:** parseOpt `12949990`.

### `--workload <tag>` (hidden)
- **Type:** string
- **Effect:** Billing-header attribution (`cc_workload`). Process-scoped. Used by SDK daemon cron subprocesses. `--print`-only.
- **Anchor:** parseOpt `12950250`.

---

## 2.6 Settings, plugins, MCP

### `--settings <file-or-json>`
- **Type:** string (file path OR inline JSON object)
- **Effect:** Additional settings. Inline JSON is persisted to a content-hashed temp file via `MNH("claude-settings", ".json", {contentHash: $})`; file path is resolved against `k8()` and read. Lazily parsed during `preAction`.
- **Anchors:** parseOpt `12950310`, handler `ut1` `12938600`.

### `--setting-sources <sources>`
- **Type:** string (comma list of `user`, `project`, `local`)
- **Default:** all sources
- **Effect:** Restricts setting scopes loaded.
- **Anchors:** parseOpt `12954012`, handler `xt1` `12938670`.

### `--plugin-dir <path>`
- **Type:** repeatable string (custom accumulator)
- **Default:** `[]`
- **Effect:** Loads session-only plugins. Repeatable.
- **Anchors:** parseOpt `12954300`, applied `12944100`.

### `--disable-slash-commands`
- **Type:** boolean
- **Effect:** **Misnamed.** Disables all skills (not slash commands). Read as `DH = O.disableSlashCommands || false`.
- **Anchor:** parseOpt `12954450`.

### `--mcp-config <configs...>`
- **Type:** repeatable string (path or inline JSON object)
- **Default:** `[]`
- **Effect:** Loads MCP servers from files/inline JSON. Errors aggregate into `"Invalid MCP configuration: …"`. Enterprise-blocked entries produce warnings.
- **Anchors:** parseOpt `12949750`, applied `12959290`.

### `--strict-mcp-config`
- **Type:** boolean
- **Effect:** Only servers from `--mcp-config`, ignoring all other sources. Errors if enterprise-managed MCP config is present.
- **Anchors:** parseOpt `12950390`, validation `12961305`.

### `--add-dir <directories...>`
- **Type:** repeatable string
- **Default:** `[]`
- **Effect:** Extra directories with tool access. Applied via `nBH(k)` at `12961470`.
- **Anchor:** parseOpt `12950350`.

### `--ide`
- **Type:** boolean
- **Effect:** Auto-connect to IDE if exactly one is detected. Plumbed as `autoConnectIdeFlag`.
- **Anchor:** parseOpt `12950330`.

### `--chrome` / `--no-chrome`
- **Type:** boolean pair
- **Default:** config-resolved
- **Effect:** Toggle Claude-in-Chrome integration. Enabled → `BY$()` → MCP config + allowedTools + system-prompt augmentation. Auto-enable (no explicit flag) still runs `BY$()` if `zmH()` truthy, but without Chrome system prompt.
- **Anchors:** parseOpt `12954520`/`12954590`, consumed `12961100`.

### `--file <specs...>`
- **Type:** repeatable string (format `file_id:relative_path`)
- **Default:** `[]`
- **Effect:** Download file resources at startup. Requires `CLAUDE_CODE_SESSION_ACCESS_TOKEN`. Uses `ANTHROPIC_BASE_URL` or `t$().BASE_API_URL`.
- **Anchors:** parseOpt `12954620`, download plumbing `12956800`.

---

## 2.7 Worktree / tmux

### `-w, --worktree [name]`
- **Type:** optional-value string
- **Gate:** `bCH()` truthy
- **Effect:** Missing name → auto-generates. Existing branch (`I86(name)`) → reused.
- **Anchors:** parseOpt `12984120`, resolution `12955650`.

### `--tmux`
- **Type:** boolean OR `=classic`
- **Effect:** tmux session for the worktree. iTerm2 native panes by default; `--tmux=classic` forces traditional tmux. Requires `--worktree`. Errors on Windows / missing tmux.
- **Anchors:** parseOpt `12984220`, validation `12955680`.

---

## 2.8 Remote control / teleport / SDK URL

### `--remote-control [name]` (hidden)
- **Type:** optional-value string
- **Effect:** Interactive session with Remote Control enabled, optionally named.
- **Anchor:** parseOpt `12986970`.

### `--rc [name]` (hidden)
- **Type:** optional-value string
- **Effect:** Alias for `--remote-control`.
- **Anchor:** parseOpt `12987130`.

### `--remote-control-session-name-prefix <prefix>`
- **Type:** string
- **Default:** hostname
- **Effect:** Prefix for auto-generated RC session names. Exported to env.
- **Anchors:** parseOpt `12987290`, export `12957560`.

### `--remote [description]` (hidden)
- **Type:** optional-value string
- **Effect:** Creates a remote session. Requires `tengu_remote_backend` feature flag + non-empty description. Emits `tengu_remote_create_session*` telemetry.
- **Anchors:** parseOpt `12986870`, applied `12979310`.

### `--teleport [session]` (hidden)
- **Type:** optional-value string
- **Effect:** Resume teleport session. Bare flag → picker. With session ID → direct resume with branch-state validation.
- **Anchors:** parseOpt `12986820`, applied `12980180`.

### `--sdk-url <url>` (hidden)
- **Type:** string (`ws://`, `wss://`, `cc+unix://`)
- **Effect:** Remote WebSocket endpoint for SDK I/O streaming. Only with `-p` + stream-json I/O. If `--print`/`--verbose` aren't explicit, auto-enabled. Pre-parse scans argv to pre-disable TTY.
- **Anchors:** parseOpt `12986665`, implicit-enable `12955800`, validation `12963900`.

---

## 2.9 Teammate / swarm / channels (hidden, feature-gated)

Registered only when `zK()` truthy / feature-flag gate passes.

### `--enable-auto-mode` — opts into auto-mode classifier; implicit when `--permission-mode=auto`. Anchor `12984430`.
### `--brief` — enables `SendUserMessage` tool (agent→user). Anchor `12984490`.
### `--channels <servers...>` — repeatable; each entry must be `server:<name>` or `plugin:<name>@<marketplace>`. Anchor `12984610`; validator `12961680`.
### `--dangerously-load-development-channels <servers...>` — loads channel servers outside allowlist. Confirmation dialog. Ignored under `--print`. Anchor `12984760`.
### `--agent-id <id>`, `--agent-name <name>`, `--team-name <name>` — must all be set together, else error `"--agent-id, --agent-name, and --team-name must all be provided together"`. Anchor `12984900`–`12985420`.
### `--agent-color <color>` — teammate UI color.
### `--plan-mode-required` — requires plan mode before implementation.
### `--parent-session-id <id>` — analytics correlation.
### `--teammate-mode <mode>` — enum: `tmux` | `in-process` | `auto`. Applied via `Nt1().setCliTeammateModeOverride()`.
### `--agent-type <type>` — custom agent type.

---

## 2.10 Core utility flags

### `-v, --version`
- **Effect:** Prints `"<version> (Claude Code)"` (currently `2.1.114`). Commander built-in.
- **Anchor:** `12984000`.

### `-h, --help`
- **Effect:** Commander help. Sorts subcommands + options alphabetically (strips `--`/`-`) via `compareOptions` in function `H` at `12942900`.

---

## 2.11 Pre-parse argv switches

Inspected BEFORE Commander runs, in `Bt1` at char `12940601`:

### `--handle-uri <uri>`
- **Effect:** Dispatches to `handleDeepLinkUri(uri)` and `process.exit()` — never reaches Commander. macOS/Linux URI-handler entry.
- **Anchor:** `12940820`.

### `-p` / `--print` / `--init-only` / `--sdk-url`
- **Effect:** Pre-parse disables TTY/banner machinery (`yKH()`, `H76(!_)`, `Sf7(_)`). `--sdk-url` matches via `startsWith` so the `=` form is caught.
- **Anchors:** `12941020`–`12941090`.

---

## 2.12 Subcommands

### `claude mcp` (at `12987677`)

**`claude mcp serve`**
- `-d, --debug` (boolean)
- `--verbose` (boolean)

**`claude mcp add <name> <commandOrUrl> [args...]`** (function `Cf7` at `12730877`)
- `-s, --scope <scope>` — `local` (default) | `user` | `project`
- `-t, --transport <transport>` — `stdio` (default) | `sse` | `http`
- `-e, --env <env...>` — repeatable `KEY=value` (stdio)
- `-H, --header <header...>` — repeatable `"Header: value"` (sse/http)
- `--client-id <id>` — OAuth client ID
- `--client-secret` — prompt OR `MCP_CLIENT_SECRET`
- `--callback-port <port>` — fixed port for OAuth callback
- `--xaa` (hidden, gated on `CLAUDE_CODE_ENABLE_XAA=1`) — XAA federated identity. Requires `--client-id` + `--client-secret` + prior `claude mcp xaa setup`.
- `-h, --help`

Warns on stdio-transport commands that look like URLs.

**`claude mcp remove <name>`**
- `-s, --scope <scope>` — scope to remove from.

**`claude mcp list`** — no flags. Health-checks stdio servers.
**`claude mcp get <name>`** — no flags. Health-checks stdio servers.

**`claude mcp add-json <name> <json>`**
- `-s, --scope <scope>` — default `local`
- `--client-secret` — prompt or env

**`claude mcp add-from-claude-desktop`**
- `-s, --scope <scope>` — default `local`. macOS + WSL only.

**`claude mcp reset-project-choices`** — no flags.

**`claude mcp xaa …`** (function `xf7` at `12735170`; gated on `me()`)
- `xaa setup`: `--issuer <url>` (required, https or loopback), `--client-id <id>` (required), `--client-secret` (prompts or reads `MCP_XAA_IDP_CLIENT_SECRET`), `--callback-port <port>` (positive int).
- `xaa login`: `--force`, `--id-token <jwt>`.
- `xaa show` / `xaa clear`: no flags.

### `claude auth` (at `12990547`)

**`claude auth login`**
- `--email <email>`
- `--sso`
- `--console` — Anthropic Console (API billing)
- `--claudeai` — Claude subscription (default)

**`claude auth status`**
- `--json` (default) / `--text`

**`claude auth logout`** — no flags.

### `claude plugin` (alias `plugins`, at `12991809`)

Global hidden `--cowork` is added to every plugin subcommand.

- `plugin validate <path>` — `--cowork`
- `plugin list` — `--json`, `--available` (requires `--json`), `--cowork`
- `plugin marketplace add <source>` — `--cowork`, `--sparse <paths...>`, `--scope <scope>` (`user` default / `project` / `local`)
- `plugin marketplace list` — `--json`, `--cowork`
- `plugin marketplace remove <name>` (alias `rm`) — `--cowork`
- `plugin marketplace update [name]` — `--cowork`
- `plugin install <plugin>` (alias `i`) — `-s, --scope` (`user` default), `--cowork`
- `plugin uninstall <plugin>` (aliases `remove`, `rm`) — `-s, --scope` (`user` default), `--keep-data`, `--cowork`
- `plugin enable <plugin>` — `-s, --scope` (auto-detect default), `--cowork`
- `plugin disable [plugin]` — `-a, --all`, `-s, --scope`, `--cowork`
- `plugin update <plugin>` — `-s, --scope` (`user` default), `--cowork`

### `claude setup-token` — no flags.
### `claude agents` — `--setting-sources <sources>`.

### `claude auto-mode` (only if `sa8() !== "disabled"`, at `12997063`)
- `auto-mode defaults` / `auto-mode config` — no flags
- `auto-mode critique` — `--model <model>`

### `claude remote-control` (hidden, alias `rc`) — no flags. Hands off to `bridgeMain(process.argv.slice(3))` at `12998170`.

### `claude doctor` — no flags.
### `claude update` (alias `upgrade`) — no flags.
### `claude install [target]` — `--force`. Positional: `stable` | `latest` | specific version.

---

## 2.13 Validation error catalog

Early-exits from the action handler (char `12963500+`):

| Error message | Condition |
|---|---|
| `Error: Invalid input format "<x>"` | `--input-format` not `text`/`stream-json` |
| `Error: --input-format=stream-json requires output-format=stream-json` | mismatched formats |
| `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json` | sdk-url w/ text |
| `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json` | bad combo |
| `Error: --include-partial-messages requires --print and --output-format=stream-json` | bad combo |
| `Error: --no-session-persistence can only be used with --print mode` | missing `--print` |
| `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` | fork missing |
| `Error: Invalid session ID. Must be a valid UUID.` | UUID parse fail |
| `Error: Session ID <uuid> is already in use.` | no fork, dup UUID |
| `Error: Fallback model cannot be the same as the main model.` | equal models |
| `Error: Cannot use both --system-prompt and --system-prompt-file.` | both set |
| `Error: System prompt file not found: <path>` | ENOENT |
| `Error: Append system prompt file not found: <path>` | ENOENT |
| `Error: --tmux requires --worktree` | missing worktree |
| `Error: --tmux is not supported on Windows` | platform |
| `Error: tmux is not installed.` | missing binary |
| `Error: --agent-id, --agent-name, and --team-name must all be provided together` | partial teammate set |
| `Error: Session token required for file downloads.` | `--file` without token |
| `Error: --remote requires a description.` | empty `--remote` w/o backend flag |
| `Error: Remote sessions are disabled by your organization's policy.` | entitlement false |
| `Error: Unable to create remote session` | API fail |
| `Error: --max-budget-usd must be a positive number greater than 0` | parser reject |
| `Error: --task-budget must be a positive integer` | parser reject |
| `--effort: It must be one of: low, medium, high, xhigh, max` | parser reject |
| `You cannot use --strict-mcp-config when an enterprise MCP config is present` | policy conflict |
| `You cannot dynamically configure MCP servers when an enterprise MCP config is present` | `--mcp-config` + enterprise |
| `Error: Invalid MCP configuration: ...` | `--mcp-config` parse errors |
| `Invalid MCP configuration: "<name>" is a reserved MCP name.` | name collision |
| `"--channels"/"--dangerously-load-development-channels" entries must be tagged: ...` | missing prefix |
| `Error: --xaa requires CLAUDE_CODE_ENABLE_XAA=1 in your environment` | XAA gate |
| `Error: --xaa requires: --client-id, --client-secret, 'claude mcp xaa setup' (settings.xaaIdp not configured)` | XAA prereqs |

---

## 2.14 Environment variables read by cli.js

### Runtime / packaging
- `NODE_OPTIONS` — scanned by `FLH()` at `50765` for `--use-system-ca`/`--use-openssl-ca` + inspector detection
- `NODE_EXTRA_CA_CERTS` — appended to CA trust
- `CLAUDE_CODE_SIMPLE` — set by `--bare`; downstream branches gate on this
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` — skips `process.title = "claude"`
- `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` — early-exit in `Uq6()`
- `CLAUDE_CODE_ENTRYPOINT` — telemetry (`github-action`/`sdk-ts`/`sdk-py`/`sdk-cli`/`claude-vscode`/`claude-desktop`/`local-agent`/`remote`/`cli`)
- `CLAUDE_CODE_REMOTE` — toggles `_GK(true)` (hook-event inclusion); restricts `permissionMode` to `acceptEdits`/`plan`
- `CLAUDE_CODE_REMOTE_SESSION_ID` — session ID for proxy + `--file` downloads
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` — remote memory directory override
- `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES` — env fallback for `--include-partial-messages`
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN` — required for `--file`
- `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` — FD-based WS auth
- `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` — `markdown`/`html`; not honored under `sdk-*`
- `CLAUDE_CODE_NO_FLICKER` — suppresses alt-screen transition
- `CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL` — force fullscreen upsell
- `CLAUDE_CODE_GIT_BASH_PATH` — Windows-only git.exe override path
- `CLAUDE_CODE_EXECPATH` — internal bootstrap path
- `CLAUDE_CODE_HOST_HTTP_PROXY_PORT` / `CLAUDE_CODE_HOST_SOCKS_PROXY_PORT` — parent proxy ports
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — disables feedback/telemetry
- `CLAUDE_CODE_ENABLE_TELEMETRY` — opt-in telemetry
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` — strips experimental beta headers
- `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` — skip IDE extension auto-install
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — gates team-mode flags
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — overrides auto-compact window
- `CLAUDE_CODE_PROFILE_QUERY` — `=1` enables query profiling
- `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` — keeps legacy model names
- `CLAUDE_CODE_ENABLE_XAA` — gates `claude mcp xaa *` + `--xaa`
- `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` — cache TTL for `apiKeyHelper` output
- `CLAUDE_CODE_AGENT_NAME` — required for team-mode broadcast
- `CLAUDE_CODE_TEAMMATE_COMMAND` — teammate subprocess command
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — overrides `max_tokens`
- `CLAUDE_CODE_SUBAGENT_MODEL` — default model for Task-spawned subagents
- `CLAUDE_CODE_USE_POWERSHELL_TOOL` — enables PowerShell tool (preview)
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` — provider managed externally
- `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` — OAuth token sources
- `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` — FD-based API key
- `CLAUDE_CODE_OAUTH_CLIENT_ID_OVERRIDE` — custom OAuth client ID
- `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY` — mTLS
- `CLAUDE_CODE_CERT_STORE` — CA store override
- `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_SKIP_BEDROCK_AUTH`
- `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_SKIP_VERTEX_AUTH`
- `CLAUDE_CODE_USE_FOUNDRY` / `CLAUDE_CODE_SKIP_FOUNDRY_AUTH`
- `CLAUDE_CODE_USE_ANTHROPIC_AWS` / `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH`
- `CLAUDE_CODE_USE_MANTLE` / `CLAUDE_CODE_SKIP_MANTLE_AUTH`
- `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` — gates `system/plugin_install` + synchronous install progress
- `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` — gates `system/session_state_changed`
- `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` — gates outbound `oauth_token_refresh` control_request
- `CLAUDE_CODE_CONTAINER_ID` — gates bash/pwsh `tool_progress` emission
- `CLAUDE_CODE_BRIEF` — env toggle for brief mode
- `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` — exported by `--remote-control-session-name-prefix`

### Anthropic SDK
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_CUSTOM_*`.

### MCP auth
`MCP_CLIENT_SECRET`, `MCP_XAA_IDP_CLIENT_SECRET`.

### Proxy
`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.

### Runtime diagnostics
`GITHUB_ACTIONS`, `GITHUB_ACTION_INPUTS`.

---

## 2.15 Flags our harness doesn't currently use

Candidates worth considering for future wiring:
- `--workload` — billing tag for automations (lowest-hanging fruit)
- `--task-budget` — token cap distinct from `--max-budget-usd`
- `--max-thinking-tokens` — deprecated, still accepted
- `--effort` — thinking-effort knob
- `--advisor` — feature-gated
- `--enable-auto-mode`, `--brief`
- `--channels`, `--dangerously-load-development-channels`
- `--agent-id`/`--agent-name`/`--team-name`/`--agent-color`/`--parent-session-id`/`--teammate-mode`/`--agent-type`/`--plan-mode-required` (swarm)
- `--thinking`, `--thinking-display` (currently driven via settings)
- `--from-pr`, `--teleport`, `--remote`, `--remote-control`, `--rc`, `--remote-control-session-name-prefix`
- `--prefill`, `--prefill-b64`, `--deep-link-origin`, `--deep-link-repo`, `--deep-link-last-fetch`, `--deep-link-cwd-b64`
- `--rewind-files`
- `--chrome`/`--no-chrome`
- `--ide` (ClaudeUI uses IPC instead)
- `--init`, `--init-only`, `--maintenance`
- `--handle-uri`
- `--enable-auth-status` — currently attempted via initialize payload (no-op). Should move to CLI flag for auth_status to actually fire.

---

## 2.16 Key code anchors

- **Commander builder `Ft1`:** char `12942893`. Decompile: `bundle-analyzer.cmd extract-fn vendor/claude-cli/cli.js 12942893`.
- **Action handler (anonymous):** `.action(async (Y, O) => {` at `~12953900`. Guards `12963500`–`12964400`.
- **Permission mode table (`g6H`/`bG`):** `1007993`.
- **MCP add handler `Cf7`:** `12730877`.
- **XAA handler `xf7`:** `12735170`.
- **Pre-parse / URI handler `Bt1`:** `12940601`.
