# ClaudeUI

A desktop client for coding agents. ClaudeUI runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [opencode](https://opencode.ai) side by side in one native app — multi-session chat, visual diffs and approvals, integrated git, terminals, automation, and usage analytics.

Built with Electron, React 19, and TypeScript. Apache-2.0.

## What it is

Coding agents live in the terminal. ClaudeUI gives them a proper surface: streaming markdown, tool calls as structured cards, approval prompts you can actually read, plans you can comment on line by line, and a sidebar of concurrent sessions across projects. It is a client, not a wrapper script — both engines are driven over their native wire protocols, and every feature works the same way regardless of which engine (or model vendor) is behind the session.

## What makes it different

- **Native Claude Code integration, no SDK.** ClaudeUI rebundles Anthropic's official standalone binary with a set of content-anchored patches, then speaks the stream-json wire protocol directly from an in-house harness. The patches unlock what the stock CLI doesn't expose: live subagent streaming, unbuffered bash output, per-request token usage, rate-limit relay, and file-based credentials. The full protocol is documented in [`docs/protocol-cc/`](docs/protocol-cc/).
- **True multi-engine.** opencode is a first-class second engine, bringing OpenAI, Google, and local models under the same UI — same tool cards, same approval flow, same session list, same usage dashboard. Engine capabilities are resolved per session and per model, so the UI only offers what the backend can actually do.
- **Cross-engine dispatch.** A session on one engine can delegate a task to a headless agent on the other — ask a GPT-backed opencode agent to review a Claude session's diff, or vice versa. The dispatched work renders as a live-streaming task card in the calling chat, with approvals forwarded, a cost cap, and usage attributed back to the dispatching session.
- **Multiple accounts.** Run several Claude accounts with per-account credentials and switch between them; usage is attributed to the right account and billing window.
- **Serious usage analytics.** 5-hour billing windows with capacity projection, daily history, per-model and per-engine breakdowns, delegated-work costs, and a configurable status line — computed locally from transcripts and live events.
- **Remote access.** An end-to-end-encrypted web client serves the same sessions to a browser or phone (QR pairing), locally or over a Cloudflare tunnel.

Alongside that: an integrated git panel with worktree support and AI commit messages, a plan-review panel with inline comments, an xterm terminal grouped per project, cron-scheduled automations with run history, voice input, Mermaid and UI-mockup rendering, a plugin system, and three themes.

## Getting started

**Requirements:** [Bun](https://bun.sh/), and a Claude subscription or API key (sign-in happens in-app). Windows and macOS are supported; Linux is a work in progress. opencode is vendored automatically — bring your own provider keys if you use it.

```bash
bun install        # also rebuilds native modules and vendors both engine binaries
bun run dev        # development mode with hot reload
```

Packaged builds:

```bash
bun run build:win     # Windows
bun run build:mac     # macOS
```

The pinned engine versions live in `package.json` (`claudeCliVersion`, `opencodeCliVersion`); `bun run update-cli` / `update-opencode` re-vendor after a bump.

## Contributing

Issues and PRs are welcome. For anything non-trivial, open an issue first to discuss the approach.

**Orientation.** `CLAUDE.md` is the map of the codebase — architecture, services, gotchas. Design decisions are recorded in [`docs/adr/`](docs/adr/); the Claude Code wire protocol in [`docs/protocol-cc/`](docs/protocol-cc/). Read the relevant ADR before changing a documented seam.

**Development.**

```bash
bun run dev          # run the app
bun run test         # unit + component + e2e (~15s)
bun run test:ci      # + git-backed tests (what CI runs)
bun run typecheck && bun run lint
```

Two things that bite everyone once:

- After any `bun install`/`add`/`remove`, run `bun run rebuild:native` — bun leaves `better-sqlite3` built for Node's ABI, which crashes the Electron app on boot.
- UI changes should be verified against the real app, not just jsdom — `scripts/app-shot.mjs` launches the built app, asserts the live DOM by `data-testid`, and screenshots it.

**Conventions.** Write tests alongside code (the suite is fast; keep it that way). Follow the two-tier `data-testid` convention for new components (ADR-027). One focused commit per change, with a descriptive message.

## License

[Apache License 2.0](LICENSE)
