# Component Implementation Guide

This guide documents the patterns and conventions for structuring React components in ClaudeUI. It complements the [testing strategy](testing-strategy.md) by explaining how component architecture enables testability.

## Directory Structure

Components with business logic (store access + IPC/store mutations) **and** enough internal complexity to warrant splitting into multiple files live in their own directory:

```
ComponentName/
  index.ts              — barrel export
  ComponentName.tsx     — FC: hooks, store access, handlers, orchestration
  View.tsx              — pure render (optional, for large components)
  utils.ts              — pure state machines (optional, only for non-trivial decision logic)
  __tests__/
    utils.test.ts                    — unit tests for pure helpers
    ComponentName.component.test.ts  — component tests (IPC bridge)
```

**When to use a directory:** The component has business logic AND at least one of: a View split, extracted utils, or enough sub-components that a single file exceeds ~300 lines of mixed concerns.

**When to stay flat:** Purely presentational components (no store access, no IPC), or components where the FC/View split doesn't reduce complexity enough to justify the directory. A 200-line component that becomes a 250-line directory with an index.ts barrel isn't worth it. Tests for flat components go in a `__tests__/` directory alongside them.

## FC / View Split

Any component that reads store state AND calls IPC or mutates the store gets split into an FC (logic layer) and a View (render layer). This is not optional for "non-trivial" components — if it has business logic, it gets split.

```tsx
// ComponentName.tsx — the FC (logic layer)
function ComponentName() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)

  const handleRespond = async (decision: 'allow' | 'deny') => {
    if (!activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, decision)
    removePendingApproval(activeSessionId, approval.requestId)
  }

  return <ComponentNameView onRespond={handleRespond} ... />
}
```

```tsx
// View.tsx — pure render, no store access, no IPC
function ComponentNameView({ onRespond, ... }: Props) {
  return (
    <button onClick={() => onRespond('allow')}>Allow</button>
  )
}
```

**Why this split?**

- The View is trivially unit-testable: render with props, assert DOM, simulate clicks, check callbacks fired.
- The FC's business logic (event → store transitions) is tested at Layer 2 via TestIpcBridge — no React rendering needed.
- The handler that calls `window.api` then updates the store is glue code — it doesn't need its own extracted function or test.

**When NOT to split:**

- The component is purely presentational — it receives props and renders JSX, with no store access or IPC calls. These are already "Views".

## Passing State from FC to View

Use **plain props** to pass state and callbacks from the FC to the View. This gives better TypeScript inference, no runtime overhead, and straightforward testability.

When the View decomposes into sub-components, pass each sub-component only the props it needs from the View's own props — standard React prop threading. Sub-components defined in `View.tsx` are tightly coupled to that View and not reusable, so explicit props keep the data flow traceable.

```tsx
// View.tsx
export function InputBoxView(props: InputBoxViewProps) {
  return (
    <div>
      <ModelPicker models={props.models} selectedModel={props.selectedModel} onSelectModel={props.onSelectModel} />
      <textarea onChange={props.onInput} />
    </div>
  )
}

// Sub-component receives only its slice of props
function ModelPicker({ models, selectedModel, onSelectModel }: {
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  onSelectModel: (value: string) => void
}) {
  const [open, setOpen] = useState(false) // UI-only state stays local
  return (...)
}
```

**Guidelines:**

- Business state + callbacks come from the FC via props. UI-only state (dropdown open/close, local animations) stays in the sub-component.
- Sub-components are defined in `View.tsx` alongside the layout component — they're tightly coupled to the View, not reusable.

## Pure Helper Extraction (utils.ts)

Only extract into `utils.ts` when the function is a **non-trivial pure state machine** — multiple branches, multiple outcomes, worth testing independently:

```ts
// utils.ts — a 6-branch state machine, worth extracting
export function resolveSendAction(ctx: SendContext): SendAction {
  if (ctx.text.trim() === '/clear') return { type: 'clear-session' }
  if (ctx.isRunning) return { type: 'queue-prompt', prompt }
  return { type: 'send-prompt', prompt, attachments }
}
```

These are tested as unit tests (Layer 1) — plain input/output assertions, no mocking.

**Do extract:**

- State machines with multiple branches and outcomes (`resolveSendAction` with 6 action types, `resolveToolVisualState` with 6 visual states)
- Display helpers used across multiple render functions within the same component (e.g. `shorten`, `trunc`, `getSummary` in ToolCallBlock)

**Keep inline in the FC or View:**

- Simple decision logic (a few `if` checks, 5-10 lines) — these get covered by component tests
- Formatting functions used only by a single sub-component (e.g. `formatTokens` used only by `StatusLine`)
- Imperative action sequences that call IPC and mutate store — these are handlers, not utilities
- Anything that would need a DI bag to be "testable" — keep it in the FC, test via TestIpcBridge

## What NOT to Do

### DI bags for testability

```ts
// BAD — manual dependency injection to test an imperative sequence
async function executeApproval(
  ctx: ApprovalActionContext,
  deps: {
    respondApproval: (...) => Promise<void>,
    removePendingApproval: (...) => void,
    updateSettings?: (...) => void,
  }
) { ... }
```

This pattern moves coupled logic out of the component and bolts on manual DI. The test ends up mocking 5 deps and asserting call order — testing implementation details, not behavior. Keep the handler inline in the FC. Test the state transitions via TestIpcBridge at Layer 2.

### Naming files `logic.ts`

The FC contains substantial logic (hooks, effects, handler orchestration). Calling extracted helpers "the logic" misrepresents where the logic lives. Use `utils.ts` — it's honest about what they are: utility functions that support the FC.

### Over-extracting small helpers

A 5-line function that checks two conditions doesn't need its own file and test suite. It's covered by the component test that exercises the flow it's part of. Only extract when the function has enough branches to warrant independent testing.

### Using React context for FC → View communication

Don't use `createContext` + `useContext` to pass state from an FC to its View. Context is designed for broadcasting state to an arbitrary subtree of consumers — it adds ceremony (provider, hook, 70-field interface) and defeats `useMemo` if any callback in the context value isn't wrapped in `useCallback`. Plain props are simpler, type-safer, and don't create hidden re-render cascades.

## Test Layer Mapping

| What to test                              | Where               | How                                              |
| ----------------------------------------- | ------------------- | ------------------------------------------------ |
| View renders correctly given props        | Layer 1 (unit)      | `render(<View {...props} />)`, assert DOM        |
| User clicks button, callback fires        | Layer 1 (unit)      | `fireEvent.click(...)`, assert `onX` called      |
| Pure state machine returns correct result | Layer 1 (unit)      | Direct function call, assert return value        |
| IPC event → store state transition        | Layer 2 (component) | TestIpcBridge `webContents.send()`, assert store |
| User action → IPC call → store cleanup    | Layer 2 (component) | Bridge handler captures IPC args, assert store   |
| Full workflow across subsystems           | Layer 3 (e2e)       | `bootTestApp()`, emit event sequences            |

The FC's inline handlers are glue code covered implicitly by Layer 2 component tests. They don't need their own extracted function or dedicated test.
