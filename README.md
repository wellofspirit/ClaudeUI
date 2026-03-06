# ClaudeUI

A full-featured desktop GUI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — turning the CLI into a rich, visual development environment.

Built with Electron, React 19, and the official `@anthropic-ai/claude-agent-sdk`.

## Why ClaudeUI?

Claude Code is powerful but lives in the terminal. ClaudeUI wraps it in a native desktop app with streaming markdown, visual diffs, tool approval workflows, multi-agent coordination, integrated terminals, and remote access — while preserving the full capability of the underlying SDK.

## Features

### Chat & Interaction
- **Streaming markdown** — live-rendered responses with syntax highlighting and a blinking cursor
- **Extended thinking** — collapsible thinking blocks showing Claude's reasoning process
- **Model & effort selection** — switch models and effort levels (low/medium/high) per message
- **File attachments** — drag-and-drop images (JPEG, PNG, GIF, WebP) and PDFs with compression
- **@ mentions** — autocomplete file references with directory navigation
- **Slash commands** — quick access to available tools and skills
- **Draft management** — unsent messages are saved and restored
- **Mobile-responsive** — touch-friendly layout with collapsible sidebar

### Tool Calling & Approval
- **Visual tool calls** — collapsible blocks showing inputs, outputs, and execution status
- **Approval workflow** — floating approval cards with allow/deny and permission suggestions
- **Permission rules** — fine-grained allow/deny/ask rules at user, project, or local scope
- **Background tasks** — send long-running tools (Bash, Agent) to the background
- **Sandbox mode** — optional sandboxed execution with network and filesystem restrictions

### Subagents & Teams
- **Subagent streaming** — real-time streaming from Agent/Task tool invocations
- **Agent tab bar** — switch between the main agent and focused subagent views
- **Subagent history** — load and browse subagent conversation history
- **Team coordination** — multi-agent teams with a monitoring dashboard showing agent status, streaming text, and task progress

### Git Integration
- **Git panel** — staged/unstaged files, diffs, and commit interface (Ctrl+Shift+G)
- **Diff viewer** — syntax-highlighted side-by-side or unified diffs
- **Staging controls** — stage, unstage, and discard individual files
- **AI commit messages** — auto-generate commit messages from diffs
- **Worktree management** — create, list, and remove git worktrees

### Plan Mode
- **Plan review panel** — dedicated panel for reviewing implementation plans
- **Inline commenting** — select text in plans and attach comments
- **Plan feedback** — compose structured feedback and choose to revise or start fresh

### Terminal
- **Integrated terminal** — xterm.js-based terminal panel with tabs (Ctrl+`)
- **Per-directory grouping** — terminals organized by working directory
- **Multi-tab** — create, close, and switch between terminal instances

### Automation
- **Scheduled sessions** — create automations with cron schedules
- **Run history** — browse past automation runs with full message replay
- **In-session messaging** — send messages to active automation runs

### MCP (Model Context Protocol)
- **Server management** — add, remove, enable/disable MCP servers
- **Multiple scopes** — user, project, local, and managed server configurations
- **Connection status** — visual indicators for server health
- **Tool discovery** — browse and search tools from connected servers

### Remote Access
- **WebSocket server** — control sessions from any browser on the local network
- **Cloudflare tunnel** — access over the internet with end-to-end encryption
- **QR code** — scan to connect from a mobile device
- **Client monitoring** — see connected clients and their IPs

### Session Management
- **Multi-session** — run concurrent sessions across different projects
- **Pin & reorder** — pin favorite sessions to the sidebar top
- **Custom titles** — rename sessions or let them auto-generate
- **History loading** — browse and restore past conversation sessions

### Usage & Analytics
- **Token tracking** — input/output/cached token breakdown per block
- **Cost estimation** — real-time cost display
- **Usage charts** — daily usage history and block timeline
- **Customizable status line** — configure what token/cost info appears in the status bar

### Settings
- **Theme** — dark, light, and auto themes
- **Font scaling** — adjustable UI zoom
- **Permission editor** — visual rule management with scope selection
- **Sandbox config** — network rules, filesystem restrictions, excluded commands
- **Additional directories** — grant filesystem access outside the project root

### Skills
- **Skill browser** — discover bundled, plugin, user, and project skills
- **Skill filtering** — search skills by name or description

## Tech Stack

- **Electron** + **electron-vite** (React TypeScript template)
- **React 19** + **TypeScript**
- **Tailwind CSS v4**
- **Zustand** for state management
- **xterm.js** for terminal emulation
- **@anthropic-ai/claude-agent-sdk** for Claude integration
- **Cloudflare Tunnel** for remote access

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Bun](https://bun.sh/) (package manager)
- A valid Claude API key or Claude Max subscription

### Install

```bash
bun install
```

### Development

```bash
bun run dev
```

### Build

```bash
# macOS
bun run build:mac

# Windows
bun run build:win

# Linux
bun run build:linux
```

### Web Build

ClaudeUI also builds as a web app for remote access:

```bash
bun run build:web
```

## Project Structure

```
src/
  shared/types.ts            — Shared TypeScript types
  main/
    index.ts                 — Electron window setup + app lifecycle
    ipc/                     — IPC handler registration
    services/                — Core services (Claude session, git, terminals, etc.)
  preload/index.ts           — Context bridge (main ↔ renderer)
  renderer/src/
    stores/session-store.ts  — Zustand store for all session state
    hooks/                   — React hooks for IPC events
    components/              — UI components (chat, sidebar, settings, etc.)
patch/                       — SDK monkey-patches applied via postinstall
docs/adr/                    — Architectural decision records
```

## SDK Patches

ClaudeUI applies several patches to the bundled `@anthropic-ai/claude-agent-sdk` to enable features not yet available upstream:

| Patch | Purpose |
|---|---|
| `subagent-streaming` | Stream events and messages from subagents |
| `team-streaming` | Stream events and messages from teammates |
| `taskstop-notification` | Notify on background task stop |
| `queue-control` | Expose message dequeue control |
| `mcp-status` | Fix MCP status returning empty arrays |
| `mcp-tool-refresh` | Refresh MCP tools after reconnection |
| `sandbox-network-fix` | Skip proxy when no network restrictions |
| `usage-relay` | Relay usage API through control messages |

Patches are applied automatically via `postinstall`. See each patch's `README.md` for details.

## License

[Apache License 2.0](LICENSE)

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.
