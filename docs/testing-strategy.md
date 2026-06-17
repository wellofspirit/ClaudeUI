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

## Layer 1: Unit Tests

**Purpose:** Verify that React components render correctly given specific props and store state. Also covers pure utility functions (formatting, parsing, math).

**What to test:**

- Given a `ChatMessage` with certain content blocks, does `MessageBubble` render the right sub-components?
- Given a tool_use block with an approval, does `ToolCallBlock` show the approval UI?
- Given formatted token counts, does `formatTokenCount` return the right abbreviation?

**What NOT to test here:**

- Business logic (event handling, state transitions, IPC routing)
- Side effects (IPC calls, navigation, timers)

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
import { useSessionStore } from '../../renderer/src/stores/session-store'

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  useSessionStore.setState({ activeSessionId: null, sessions: {} })
  wireEventHandlers(app) // same pattern as component tests
})

afterEach(() => {
  app.teardown()
})

it('full conversation flow', () => {
  useSessionStore.getState().createNewSession('r1', '/test')
  app.emit('session:user-message', 'r1', { prompt: 'Hello', queued: false })
  app.emit('session:stream', 'r1', { type: 'text', text: 'Hi there' })
  app.emit('session:message', 'r1', makeAssistantMessage('Hi there'))
  app.emit('session:result', 'r1')

  const session = useSessionStore.getState().sessions['r1']
  expect(session.messages).toHaveLength(2)
  expect(session.status.state).toBe('idle')
})
```

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
bun run test:e2e       # Layer 3 — e2e tests only
bun run test:integration # Layer 4 — integration tests (needs CLAUDE_INTEGRATION_TESTS=1)
bun run test:ci        # Layers 1+2+3 — what runs in CI pipeline
bun run test:watch     # Unit tests in watch mode
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
- **SDK upgrade** → Run integration tests, update factories if event shapes changed
- **New patch** → Integration test verifying the patched behavior

### What NOT to test

- Don't test Electron APIs (we mock them)
- Don't test third-party library internals
- Don't test trivial getters/setters
- Don't chase coverage numbers — focus on catching real regressions
