# Architecture

How ClaudeUI is put together. This directory splits the architecture by concern — read the file that matches your task. Design rationale lives in [`docs/adr/`](../adr/adr.md); the cli.js wire protocol in [`docs/protocol/`](../protocol/README.md).

| File | Covers |
| ---- | ------ |
| [source-layout.md](source-layout.md) | Source tree + the main-process service catalog |
| [engines.md](engines.md) | Multi-engine seam (engine/vendor/account, capabilities, opencode + pi backends, cross-engine dispatch), auth/accounts |
| [data-flow.md](data-flow.md) | IPC & data flow, key runtime patterns, cli.js integration pointers |
| [persistence.md](persistence.md) | Config/operational persistence planes, settings & config wiring |
| [ui.md](ui.md) | Views, theming, layout, working-on-the-app gotchas |
| [remote.md](remote.md) | Remote access **transport + auth** as built — HTTP/WS listener, wire frames, auth modes, E2E, scoped URL tokens, tunnel/TLS |
| [sync-core.md](sync-core.md) | **SyncCore** — state sync, replication, queueing, terminal, headless (ADR-051/053). Phases 0-4 landed; phase 5 + the follow-on ledger are here too |
| [security.md](security.md) | Remote-access security model **as built** — passkeys, policy modes, capability grants, decay, audit (ADR-052) |
| [sync-channels.md](sync-channels.md) | Every event channel classified — ring / canonical / delivery, plus the recorded gaps and the payload additions (SyncCore phases 4a-4b + the post-4 `session:created` birth config) |

## Overview

ClaudeUI is an Electron app. The **main process** owns the engines (spawning Claude Code's `bun-claude` binary, driving `opencode serve` over HTTP+SSE, driving `pi --mode rpc` over stdio JSONL), git, terminals, persistence, and the remote-access server. The **renderer** is a React 19 app fed exclusively through typed IPC events; it never touches an engine directly. A **web client** (`src/web/`) mirrors the renderer's API surface over an E2E-encrypted WebSocket (as-built: [remote.md](remote.md); target: [sync-core.md](sync-core.md)).

## Tech stack

Electron (`electron-vite`), React 19 + TypeScript, Tailwind CSS v4 (via `@tailwindcss/vite`, no config files), Zustand, `react-markdown` + `remark-gfm`, `@modelcontextprotocol/sdk` (in-process MCP hosting), `simple-git`, `node-pty` + `@xterm/xterm`, `better-sqlite3` (operational DB), `mermaid`, `cron-parser`, Prism.js. Package manager: **bun**.

Claude Code is integrated by rebundling Anthropic's official Bun standalone binary with patched `cli.js` (`vendor/claude-cli/bun-claude[.exe]`) and speaking stream-json to it from an in-house harness — no `@anthropic-ai/claude-agent-sdk` dependency. Pipeline and patches: `docs/protocol/01-transport.md` §1.12; rationale: ADR-006.
