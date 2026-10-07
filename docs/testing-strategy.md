# Testing Strategy

This document defines the testing architecture for ClaudeUI. It describes the four test layers, what each one tests, how to write tests for each layer, and the conventions to follow.

## Architecture Overview

The app has two natural boundaries:

```
┌──────────────────────────────────────┐
│         Renderer (React)             │
│  Components, Hooks, Stores           │
│         ↕ window.api (ClaudeAPI)     │  ← Boundary 1: Electron IPC
├──────────────────────────────────────┤
│         Main Process                 │
│  IPC Handlers → Services             │
│         ↕ SDK / fs / git / pty       │  ← Boundary 2: External deps
├──────────────────────────────────────┤
│         External World               │
│  claude-agent-sdk, simple-git,       │
│  node-pty, filesystem, HTTP          │
└──────────────────────────────────────┘
```

Tests are organized into four layers that target different concerns:

| Layer           | What it tests                            | What it fakes                         | Runs in CI |
| --------------- | ---------------------------------------- | ------------------------------------- | ---------- |
| **Unit**        | Pure rendering, pure functions           | Store selectors (pre-populated state) | Yes        |
| **Component**   | Business logic (events → state)          | Electron IPC transport, SDK           | Yes        |
| **E2E**         | Full pipeline (action → state → outcome) | Electron IPC transport, SDK           | Yes        |
| **Integration** | SDK event contracts                      | Nothing (real SDK)                    | No (gated) |
| **Layout**      | Geometry (flex, container queries, z)    | Nothing (real CSS, real Chromium)     | Yes        |

## Layer 1: Unit Tests

**Purpose:** Verify that React components render correctly given specific props and store state. Also covers pure utility functions (formatting, parsing, math).

**What to test:**

- Given a `ChatMessage` with certain content blocks, does `MessageBubble` render the right sub-components?
- Given a tool_use block with an approval, does `ToolCallBlock` show the approval UI?
- Given formatted token counts, does `formatTokenCount` return the right abbreviation?

**What NOT to test here:**

- Business logic (event handling, state transitions, IPC routing)
- Side effects (IPC calls, navigation, timers)

**Environment:** two vitest projects share Layer 1 and differ only in environment. `unit-node` runs the unit tests under `src/{main,core,shared,server,preload}` in plain Node, with `src/test/setup/node.setup.ts`; `unit` runs every other unit test under jsdom. A jsdom window per file was the largest single cost of the suite, and the non-renderer code never touches the DOM. A unit test placed in those folders gets no `window` or `document`; give it a `// @vitest-environment jsdom` docblock if it really needs one.

**Never switch the pool to `threads`.** Inside a worker thread, the setup files' `process.env.USERPROFILE`/`HOME` redirect changes only the thread's copy of the environment, while `os.homedir()` reads the real process environment, so tests would reach the developer's real `~/.claude`. The default `forks` pool keeps one process per worker.

**How to write:**

```typescript
// File: src/renderer/src/components/chat/__tests__/MyComponent.unit.test.tsx

import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { makeChatMessage, makeTextBlock } from '@test/factories/messages'

beforeEach(() => {
  // Pre-populate store with the state your component needs
  useSessionStore.setState({
    activeSessionId: 'test',
    sessions: { 'test': { /* minimal session state */ } },
    settings: { /* relevant settings */ },
  })
  // Stub window.api methods the store calls internally
  window.api = { saveSessionConfig: () => {}, /* ... */ } as any
})

it('renders text content', () => {
  const msg = makeChatMessage({ content: [makeTextBlock('Hello')] })
  render(<MyComponent message={msg} />)
  expect(screen.getByText('Hello')).toBeInTheDocument()
})
```

**File naming:** `*.unit.test.tsx` or `*.test.ts` (existing convention)

**File location:** `src/**/__tests__/`

## Layer 2: Component Tests

**Purpose:** Verify business logic — the state machine that drives the app. When an IPC event arrives, does the store update correctly? When status changes, do approvals get cleared? When a session rekeys, does the old key disappear?

This is the highest-value test layer. It catches the bugs that actually ship: broken event handlers, incorrect state transitions, race conditions in approval flows.

**What to test:**

- IPC event → store state transition (message arrives → addMessage updates session)
- Session rekey flow (status event with different sessionId → old key removed, new key created)
- Approval lifecycle (request arrives → pending in store → status idle → cleared)
- Todo dismissal (all completed + result event → todos cleared)
- Multi-session isolation (events for session A don't affect session B)
- Error accumulation, permission mode changes, team events, subagent streaming

**What NOT to test here:**

- React rendering (that's Layer 1)
- Full pipeline end-to-end (that's Layer 3)
- Real SDK behavior (that's Layer 4)

**How to write:**

```typescript
// File: src/renderer/src/hooks/__tests__/myLogic.component.test.ts
// Note: .ts not .tsx — no React rendering

import { TestIpcBridge } from '@test/bridges/test-ipc-bridge'
import { useSessionStore } from '../../stores/session-store'
import { makeSessionStatus } from '@test/factories/messages'

let bridge: TestIpcBridge

beforeEach(() => {
  bridge = new TestIpcBridge()
  // Stub window.api for store internal calls
  window.api = { saveSessionConfig: () => {} /* ... */ } as any
  // Reset store
  useSessionStore.setState({ activeSessionId: null, sessions: {} })
  // Wire event handlers (same logic as useClaudeEvents)
  wireMyEventHandlers(bridge)
})

afterEach(() => {
  bridge.reset()
})

it('rekeys session when status has different sessionId', () => {
  useSessionStore.getState().createNewSession('temp-id', '/test')
  bridge.webContents.send(
    'session:status',
    'temp-id',
    makeSessionStatus({
      state: 'running',
      sessionId: 'stable-uuid'
    })
  )
  expect(useSessionStore.getState().sessions['stable-uuid']).toBeDefined()
  expect(useSessionStore.getState().sessions['temp-id']).toBeUndefined()
})
```

**Key pattern:** Wire event handlers manually using `TestIpcBridge` — replicate the logic from `useClaudeEvents` but without React. The bridge's `webContents.send()` fires events to registered `ipcRenderer.on()` listeners, which call store actions.

**File naming:** `*.component.test.ts`

**File location:** `src/**/__tests__/`

## Layer 2b: Browser layout tests

**Purpose:** Verify a claim about geometry. jsdom evaluates no layout: every `getBoundingClientRect()` is zeros, container queries never fire, and `zoom` does nothing. A bug that is "the Stop button is clipped on my phone" is invisible to Layers 1-3 by construction, and that is exactly the bug class this layer exists for.

**What it is:** the `browser` vitest project. Real Chromium (`@vitest/browser-playwright`, headless), real Tailwind (the same `react()` + `tailwindcss()` plugins as the renderer build), `src/renderer/src/assets/main.css` loaded, at the owner's phone size. It has its own setup file (`src/test/setup/browser.setup.ts`: the stylesheet and a `window.api` Proxy whose members resolve `{ success: true }`) and does NOT load the jsdom setup: no throwaway home, no SQLite driver. Failure screenshots and attachments are redirected out of the source tree (`.cache/`).

**When to write one:** any invariant a layout can break that jsdom cannot see: something fits, wraps, truncates, overlaps, stays inside the screen, or switches layout at a container width (`@max-[400px]/roster:`). Pin the invariant, not the pixels. Component and E2E tests still own logic; do not move them here.

**The reference profile:** `scripts/lib/mobile-profiles.mjs` is the one place the device numbers live (`s25-ultra-edge`: 412 x 728 CSS px, Edge on Android, `uiFontScale` 1, 1.1 and 1.5). The vitest project and `scripts/app-shot.mjs --profile` both import it, so the tests and the real-app check cannot disagree about what "the phone" is. Every test loops over `fontScales`.

**The zoom wrapper:** SessionView renders the app under CSS `zoom: uiFontScale` with `width: calc(100vw / scale)`, and inside a zoomed subtree `vw`/`vh` lengths are multiplied by the zoom. A test that mounted a component bare would never meet the bug. `ZoomFrame` and `LayoutComposer` (`src/test/helpers/mobile-layout.ts`) reproduce SessionView's root and the composer's margins; mount through them, and measure with `getBoundingClientRect()` (page px under Chromium's standardised zoom), which is what the screen shows.

**Use the zoom and the container chain of the surface under test.** There are two zooms. The composer, the roster overlay and the dialogs are under the app zoom (`uiFontScale`). The chat's message list is zoomed again by ChatPanel (`chatFontScale / uiFontScale`), so a Task card is under `chatFontScale` alone, and is much narrower than the window: scroller `mr-2`, column `px-3`, and the bordered `p-2` group around two or more tool calls (about 404/chatScale - 42 px on the phone). `LayoutChatList` models that chain with the file:line of each class; a card test drives `chatScale` through it, and a test that put the card in the app-zoom wrapper measured a card 26px too wide and predicted a footer on one line that wrapped in the app.

**Seeding:** components read the Zustand store directly. Set it with `useSessionStore.setState({ activeSessionId, sessions: { [id]: { ...EMPTY_SESSION_STATE, ... } }, availableModels })`; there is no IPC bridge here. If a component needs more than the store, that part belongs in Layer 2.

**How to write:**

```tsx
// File: src/**/__tests__/MyThing.browser.test.tsx
import { render } from '@testing-library/react'
import {
  FONT_SCALES,
  ZoomFrame,
  LayoutComposer,
  rectOf,
  hasNoHorizontalOverflow
} from '@test/helpers/mobile-layout'

for (const scale of FONT_SCALES) {
  it(`fits the phone at uiFontScale ${scale}`, async () => {
    seedTheStore()
    const view = render(
      <ZoomFrame scale={scale}>
        <LayoutComposer>
          <MyThing />
        </LayoutComposer>
      </ZoomFrame>
    )
    expect(rectOf(view.getByTestId('MyThing')).right).toBeLessThanOrEqual(window.innerWidth)
  })
}
```

Prove a guard: revert the production fix and watch the test fail before you trust it.

**Assert readability, not just containment.** "Nothing overflows" is a weak claim: a name squeezed to one character and a model chip squeezed to "D." contain perfectly. The first round of these tests asserted only containment, and those defects passed. For every element a layout can shrink, also assert a floor on what is left:

- a name or a model is at least its minimum width, or all of its text if that is shorter (`clientWidth >= min(scrollWidth, floor)`);
- a badge or chip that must stay whole is not truncated (`scrollWidth <= clientWidth`);
- a header is ONE row (`rowCount` of its visible children, by vertical centre) and keeps its description at its floor;
- what a breakpoint sheds is shed where it should be (assert `innerText`, which skips `display: none`, and that `textContent` still has the words for assistive tech).

Check at every scale in the profile plus 1.25, and revert the fix to prove the assertion fails.

**File naming:** `*.browser.test.tsx`, under `src/**/__tests__/`. The `unit` project excludes them.

**Speed:** about 7 s for the project, most of it starting Chromium. It runs in `bun run test` and `test:ci`.

## Layer 3: E2E Tests

**Purpose:** Verify the full pipeline — from user action through IPC bridge to store update to final state. These tests wire the complete app stack (minus Electron shell and SDK subprocess) in a single process.

**What to test:**

- Complete conversation flow: send prompt → user message event → streaming → assistant message → result → idle
- Approval flow end-to-end: tool use → approval request → user approves → tool result → continue
- Session rekey through the full chain
- Error propagation from main to renderer
- Multi-session isolation under concurrent events

**When to add E2E tests:**

- When a bug involves multiple subsystems interacting (e.g., "rekey breaks streaming")
- When you want to verify a user-visible workflow works end-to-end
- As smoke tests for critical paths

**How to write:**

```typescript
// File: src/e2e/flows/my-flow.e2e.test.ts

import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { appendItem, emitItemDelta, sealItem } from '@test/helpers/item-stream'
import { useSessionStore } from '../../renderer/src/stores/session-store'

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.setState({ activeSessionId: null, sessions: {} })
})

afterEach(() => {
  app.teardown()
})

it('full conversation flow', () => {
  useSessionStore.getState().createNewSession('r1', '/test')
  app.emit('session:user-message', 'r1', { prompt: 'Hello', queued: false })

  // Assistant output is a per-item lifecycle: reliable open, volatile chunks,
  // reliable seal carrying the resolved final content.
  const target = emitItemDelta(app, 'r1', 'Hi ', { open: true })
  appendItem(app, 'r1', target, 'there')
  sealItem(app, 'r1', target, 'Hi there')

  app.emit('session:result', 'r1')

  const session = useSessionStore.getState().sessions['r1']
  expect(session.messages).toHaveLength(2)
  expect(session.status.state).toBe('idle')
})
```

`@test/helpers/item-stream` wraps the three channels with a deterministic transcript
identity so a flow test does not have to hand-build `ItemStreamTarget`s:
`emitItemDelta(app, routingId, chunk, { open: true, kind?, messageId?, ownerToolUseId? })`
returns the target, `appendItem` adds a chunk to it, and `sealItem` commits the final
text. There is no separate handler-wiring step — `bootTestApp()` installs the real
replica, so `app.emit` folds through the shared reducer and projects into the store.

**`bootTestApp()`** creates a `TestIpcBridge`, registers stub IPC handlers for internal store calls (`config:save-sessions`, etc.), builds `window.api` backed by the bridge, and returns `{ bridge, api, emit, teardown }`.

**`app.emit(channel, ...args)`** is shorthand for `bridge.webContents.send()` — simulates the main process pushing an event to the renderer.

**File naming:** `*.e2e.test.ts`

**File location:** `src/e2e/flows/`

## Layer 4: Integration Tests

**Purpose:** Verify that the real SDK produces the event sequences our other tests assume. When the SDK upgrades or patches change, these tests break first — telling you the contract changed before your app code silently breaks.

**What to test:**

- Real SDK yields `init → assistant → result` in the correct order
- Real SDK's assistant messages have `{ role: 'assistant', content: [...] }` structure
- Real SDK's `canUseTool` callback fires for tool use
- Factory functions in `@test/factories/sdk-events.ts` produce structurally valid events

**Gating:** Tests that hit the real SDK require `CLAUDE_INTEGRATION_TESTS=1` environment variable and valid API auth. They are excluded from CI. Factory shape validation tests run always.

**How to write:**

```typescript
// File: src/integration/sdk-contract/my-contract.integration.test.ts
// @vitest-environment node

const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS

describe.skipIf(SKIP)('real SDK behavior', () => {
  it('text response yields correct event order', async () => {
    const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk')
    const events = []
    for await (const msg of sdkQuery({ prompt: 'Say hello', options: { ... } })) {
      events.push(msg)
    }
    expect(events.some(e => e.type === 'assistant')).toBe(true)
    expect(events[events.length - 1].type).toBe('result')
  })
})

// Always-run tests that validate factory shapes
describe('factory validation', () => {
  it('textResponseSequence is structurally valid', async () => {
    const { textResponseSequence } = await import('@test/factories/sdk-events')
    const events = textResponseSequence('s1', 'Hello')
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' })
  })
})
```

**File naming:** `*.integration.test.ts`

**File location:** `src/integration/`

**Running:** `CLAUDE_INTEGRATION_TESTS=1 bun run test:integration`

**Engine binaries.** Claude Code comes from `vendor/claude-cli`. opencode, pi and Codex are not vendored (ADR-082 §8): the suites run the ones in ClaudeUI's managed store, `~/.claude/ui/harnesses` (`postinstall`, or `bun run ensure-<id>`, installs the tested versions). The project's setup moves HOME to a throwaway directory, so `vitest.config.ts` names the real store through `CLAUDEUI_HARNESS_STORE` for the `integration` project only; set it yourself to run against another store. A suite whose engine is not installed skips. The `unit` and `unit-node` projects get the same store read-only as `CLAUDEUI_TEST_HARNESS_STORE`, for the one unit test that runs a real binary (`rules-sync.test.ts` against Codex's `execpolicy` parser); every other unit test keeps the throwaway store.

**The Codex fixture provider.** The real-binary Codex suites (`src/integration/codex/*.integration.test.ts`, gated by `CODEX_INTEGRATION=1`) never talk to a paid provider: they run against one shared localhost Responses server, `src/integration/codex/fixture-provider.ts`, which also writes the isolated `CODEX_HOME` (`config.toml`, `auth.json`) the child reads. `scripts/codex-fixture-provider.mjs` is a thin CLI wrapper around the same module, so a real-app drive and the integration suites exercise the identical fixture — there is deliberately no second copy. Its `chatgpt` mode serves a drive under an INJECTED ChatGPT identity (ADR-068 §1): `chatgpt_base_url` is pointed at the fixture, the binary's own backend calls are answered 404 and recorded, any bearer is accepted, and `writeFabricatedVault()` mints the scratch vault it comes from (it refuses `os.homedir()`). On the CLI: `--chatgpt --vault-home <home> --accounts <n>`, or `scripts/codex-render-stress.mjs --accounts <n>`. The module's own guards are `src/integration/codex/__tests__/fixture-provider.test.ts`, which runs everywhere — the suites it serves do not.

**The opencode contract suite.** `src/integration/opencode/*.contract.integration.test.ts` (gated by `OPENCODE_V2_INTEGRATION=1`; the name predates the 1.x removal) runs a real `opencode serve --stdio` of the pinned 2.x version against an in-process localhost fixture model (`harness/fixture-provider.ts`, scripted by markers in the last user message), with `HOME`/`XDG_*` under `.cache/opencode-v2-it/`, a refusing proxy and, on darwin, a loopback-only `sandbox-exec` profile. It is the per-pin-bump gate of ADR-097 §8.1; details in `docs/protocol-opencode/README.md` §Contract suite. It is the only opencode integration suite: the 1.x one was deleted with the 1.x adapter (ADR-097 S10a).

## Test Infrastructure

### TestIpcBridge (`src/test/bridges/test-ipc-bridge.ts`)

In-process replacement for Electron's IPC. Implements both patterns:

- **Request-response:** `ipcRenderer.invoke(channel, ...args)` → `ipcMain.handle(channel, handler)` → returns result
- **Push events:** `webContents.send(channel, ...args)` → `ipcRenderer.on(channel, handler)` callbacks

Not a behavioral mock — a faithful transport implementation.

### Electron Shim (`src/test/stubs/electron-shim.ts`)

Mocks the `electron` module. Provides stubs for `app`, `ipcMain`, `ipcRenderer`, `BrowserWindow`, `dialog`, `shell`, `Menu`. The `ipcMain`/`ipcRenderer` exports delegate to a `TestIpcBridge` instance wired via `setIpcBridge()`.

### SDK Stub (`src/test/stubs/sdk-stub.ts`)

Replaces `sdkQuery()`. Returns an async generator yielding configurable events, with control methods (`interrupt`, `setPermissionMode`, etc.) as trackable spies. Used when tests need to control what the SDK "returns."

### bootTestApp (`src/test/helpers/boot-test-app.ts`)

Orchestrator for Layer 2/3 tests. Creates bridge, registers stub IPC handlers for internal store operations, builds `window.api`, returns `{ bridge, api, emit, teardown }`.

### Factory Functions (`src/test/factories/`)

- **`messages.ts`**: `makeChatMessage()`, `makeUserMessage()`, `makeAssistantMessage()`, `makeTextBlock()`, `makeToolUseBlock()`, `makeToolResultBlock()`, `makeThinkingBlock()`, `makeSessionStatus()`, `makePendingApproval()`, `makeTaskNotification()`, `makeTodoItem()`
- **`sdk-events.ts`**: `initEvent()`, `streamTextEvent()`, `assistantMessageEvent()`, `resultEvent()`, `textResponseSequence()`, `toolUseSequence()`, `thinkingSequence()`

## Commands

```bash
bun run test           # All layers
bun run test:unit      # Layer 1 — unit tests only
bun run test:component # Layer 2 — component tests only
bun run test:browser   # Layer 2b — browser layout tests only (real Chromium, phone viewport)
bun run test:e2e       # Layer 3 — e2e tests only
bun run test:integration # Layer 4 — integration tests (needs CLAUDE_INTEGRATION_TESTS=1)
bun run test:ci        # Layers 1+2+2b+3 and the git project — what runs in CI pipeline
bun run test:watch     # Unit + component tests in watch mode
```

## Conventions

### File naming

| Layer       | Pattern                          | Example                               |
| ----------- | -------------------------------- | ------------------------------------- |
| Unit        | `*.unit.test.tsx` or `*.test.ts` | `MessageBubble.unit.test.tsx`         |
| Component   | `*.component.test.ts`            | `useClaudeEvents.component.test.ts`   |
| E2E         | `*.e2e.test.ts`                  | `basic-conversation.e2e.test.ts`      |
| Integration | `*.integration.test.ts`          | `event-sequences.integration.test.ts` |

### File location

- Unit and component tests: `src/**/__tests__/` (near the code they test)
- E2E tests: `src/e2e/flows/`
- Integration tests: `src/integration/`
- Shared infrastructure: `src/test/`

### Store setup in tests

The Zustand store is a module singleton. Reset it in `beforeEach`:

```typescript
useSessionStore.setState({
  activeSessionId: null,
  sessions: {},
  directories: [],
  recentSessionIds: [],
  pinnedSessionIds: [],
  customTitles: {}
})
```

The store internally calls `window.api.saveSessionConfig()` when sessions are created/removed. Provide a stub:

```typescript
window.api = { saveSessionConfig: () => {} } as any
```

Or use `bootTestApp()` which registers stub IPC handlers for these channels automatically.

### When to add tests

- **New store action or event handler** → Component test
- **New React component** → Unit test
- **Bug that spans multiple subsystems** → E2E test
- **A claim about geometry** (fits, overlaps, truncates, collapses at width N, paints above) → Layout test; jsdom cannot evaluate it
- **SDK upgrade** → Run integration tests, update factories if event shapes changed
- **New patch** → Integration test verifying the patched behavior

### What NOT to test

- Don't test Electron APIs (we mock them)
- Don't test third-party library internals
- Don't test trivial getters/setters
- Don't chase coverage numbers — focus on catching real regressions
