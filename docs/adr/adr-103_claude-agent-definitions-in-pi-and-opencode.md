# ADR-103: Claude Code agent definitions in pi and opencode

**Status:** Accepted (2026-10-16). Implementation on branch `agent-shim`; resume notes in
`docs/agent-shim-handoff.md`.
**Amends:** [ADR-089](adr-089_pi-subagents-host-run.md) (the pi agent registry gains Claude Code's agent
folders and the `harness.pi.model` key; `source` becomes `scope` + `origin`).
**Relates to:** [ADR-097](adr-097_opencode-v2-only.md) §2–§4 (the injected `OPENCODE_CONFIG_CONTENT`, server
identity, permission overlays), [ADR-029](adr-029_opencode-custom-agent-crud.md) (opencode's own agent files
win), [ADR-026](adr-026_development-workflow.md) (the role agents this exists for).

## Context

The owner's workflow (ADR-026) dispatches user-level role agents — `orch-reader`, `orch-implementer`,
`orch-verifier`, `orch-design-reviewer`, `orch-pr-reviewer` — defined once, as Claude Code agent files in
`~/.claude/agents` (synced from the owner's config repo). The owner runs pi and opencode only through ClaudeUI and
wants the same agents there, each harness running them on its own models, without copies and without patching either
harness.

- pi has no native subagents; ClaudeUI host-runs them (ADR-089) from a registry that already read Claude-shaped
  files from `~/.pi/agent/agents` and `.pi/agents`.
- opencode 2.x reads agents from its own folders and from config; it does not read `~/.claude/agents` (it uses discovered `.claude` folders for skills only), and a
  Claude-style file in its own folders is decoded as a 1.x agent: dropped when `tools` is a string, otherwise loaded
  as a legacy agent with the Claude-only keys passed through. ClaudeUI already
  injects config into every opencode server it spawns (`OPENCODE_CONFIG_CONTENT`, ADR-097 §2).

## Decision

### One file, a block per harness

An agent file keeps Claude Code's shape and may add a `harness` map that Claude Code ignores:

```yaml
---
name: orch-reader
description: Collects evidence for the orchestrator ...
model: sonnet # Claude Code
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch
harness:
  pi:
    model: openai-codex/gpt-6-luna
  opencode:
    model: openai/gpt-6-luna
---
```

Each harness reads only its own block, and the body (the system prompt) names no harness or model, so no
harness sees another's choices.

### pi (the agent registry)

- Sources, later wins per normalized name: built-ins < `~/.claude/agents` < `~/.pi/agent/agents` < for each
  project directory from the root down, `.claude/agents` then `.pi/agents`. The harness's own folder wins at
  equal scope; a nearer directory beats a farther one; every override of a built-in or user agent is a
  diagnostic, and a project agent that shadows one is marked `(project)` in the listing.
- **A project file can only narrow what it shadows** (owner ruling): the project definition supplies the prompt
  and description, but the restrictions of both apply: `tools` intersect, `disallowedTools` add up, the stricter
  permission mode and the stricter `canSpawn` win, and the shadowed agent's model is kept unless a project
  `.pi/agents` file names one. A repository therefore cannot turn the user's read-only agent (or the read-only
  `Explore`/`Plan`) into an all-tools one by shipping a file of the same name, nor move it onto the parent's
  model. Between the user's own folders (`~/.claude/agents`, `~/.pi/agent/agents`) plain precedence applies.
- `harness.pi.model` wins over `model`. A project `.claude/agents` file never picks a model (inherit + a
  diagnostic): a repository must not choose the user's vendor or spend. Project `.pi/agents` keeps ADR-089's
  rules.
- The `agent` tool's listing hides Claude Code built-in tools pi does not have (`WebFetch`, `WebSearch`, ...);
  extension and MCP tools still show. The names still reach `--tools`, which pi turns into a name matcher, so an
  unknown name matches nothing.
- The hardened definition reader (no evaluation, aliases refused, size and count caps) is shared with opencode
  (`src/core/agents/agent-defs.ts`).

### opencode (the injected config)

- The same two folders are read with the same reader. A name opencode already has is not injected: the harness's
  own definition wins. "Already has" mirrors opencode's own discovery, because the injected document is applied
  last and would otherwise rewrite the native agent: built-ins, `agents.<name>` in every config document opencode
  loads, and agent files in the global and every discovered `.opencode` folder (`agent`/`agents`, recursive, and
  `mode`/`modes`).
- Each agent is injected as a native 2.x subagent: `mode: "subagent"`, `description`, `system` = a short
  ClaudeUI preamble plus the body, `model` from `harness.opencode.model` (user scope only; a model outside
  ClaudeUI's opencode allowlist skips the agent rather than substitute one). opencode's `system` REPLACES its
  default prompt where pi's `--append-system-prompt` appends; the preamble carries the harness detail so the
  agent file does not have to.
- Tools become **deny-only** permissions: a deny for every action the tools list does not name (and for every
  MCP server it does not name), plus the `disallowedTools`. Never an allow: an allow would widen the
  default rules (e.g. turn the `.env` read asks into allows) and an all-deny would, through the child-session
  rules, cut the child off from paths outside the session directory.
  MCP follows Claude Code's rule that a tools allowlist without MCP names gets no MCP tools: every bridged
  server, every server in `mcp.servers` of the config documents opencode loads for the directory, and ClaudeUI's
  hosted `claudeui` server is denied unless the list names it at server level
  (`mcp__<server>`), and a denied server's resources go with it (`opencode_list_mcp_resources` on the server name,
  `opencode_read_mcp_resource` on `<server>:*`); a tool-level entry (`mcp__github__issues`) cannot be expressed
  deny-only, so it keeps the server denied, with a diagnostic. A server that exists only at runtime (not in any
  config document) is not known when the config is built and is not denied.
- Rule order for an injected agent: the user's global opencode `permissions` first, then the agent's own denies,
  then ClaudeUI's own per-agent overlay for that name (ADR-097 §3, e.g. `plan`'s); last match wins, so the
  agent's denies beat the user's global allows.
- A malformed `harness.opencode.model` skips the agent (never a silent substitute); a name that is not a safe
  opencode agent id (`My Agent`) is skipped; names compare case-insensitively with opencode's own agents.
- Session rules sit after agent rules in opencode, so a parent's `*: allow` would beat an agent's denies until
  ClaudeUI applies the child-session ruleset (`subagent-permissions.ts`); the contract suite covers that path.
  opencode's browser plugin appends its own `browser` deny to every agent.
- A project definition that shadows a user one narrows it as in pi: its rules are the union of both agents'
  denies, and the user agent's model is kept. Project `.claude/agents` prompts are still repository-supplied text
  the model sees, like a repository's `CLAUDE.md`; they cannot widen permissions or pick a model.
- Size caps (8 KiB per agent, 24 KiB in all) keep the injection well inside one Windows environment variable
  (32,767 characters); a real Windows spawn with a 22 KB block became ready normally.
- The injected block is part of the server identity, so an edited agent file starts a fresh server on the next
  session; the old one ends when its last session releases it.

## Consequences

- One set of agent files serves Claude Code, pi and opencode; per-harness models live beside each other in the
  file and nowhere else.
- opencode 2.x reads `AGENTS.md`, not `CLAUDE.md`, so an injected agent does not see a repository's `CLAUDE.md`
  rules; until that is addressed the orchestrator appends them to opencode briefs (ADR-026).
- Claude Code scans agent folders recursively; both shims read them flat.

## Alternatives considered

- **Generate per-harness agent files from the config repo.** Rejected: the owner never runs pi or opencode
  outside ClaudeUI, so a runtime shim keeps one source and nothing to re-sync.
- **Flat `pi-model` / `opencode-model` keys.** Rejected for one nested `harness` key: one unknown key for Claude
  Code to ignore, and room for other per-harness fields later.
- **A deny-all + allow-list permission mapping.** Rejected (see above): it both widened and broke access.
