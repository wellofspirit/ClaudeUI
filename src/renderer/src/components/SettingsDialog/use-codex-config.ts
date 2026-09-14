/**
 * ONE config object behind every Codex pane (ADR-065 § As built item 3,
 * ADR-068 §6).
 *
 * The Codex page draws eleven group cards over a SINGLE file, and several of
 * them are on screen at once. Every write carries `expectedVersion` — the
 * version the caller last READ — and the app-server refuses a write whose token
 * is stale (probe (b), `docs/codex-spike.md`). So if each pane held its own
 * snapshot, the first commit would invalidate every other pane's token and the
 * user's second click would be refused for a reason they did not cause.
 *
 * The Dispatch page hit the same wall for a different reason (a whole-file save)
 * and solved it the same way, so this is that pattern, not a new one:
 *
 *  - the entry is created by the FIRST subscriber, which starts the single read;
 *    later subscribers join the entry and the in-flight read, so mounting eleven
 *    panes is one IPC round trip, not eleven;
 *  - every write goes through the entry, and the entry re-reads after it, so the
 *    version token advances in ONE place;
 *  - a version conflict is NOT an error the user caused: the entry re-reads and
 *    raises one notice ("config.toml changed on disk"), which the page shows
 *    once and the next write uses the fresh token;
 *  - the entry is DROPPED when the last subscriber unsubscribes, so reopening
 *    Settings re-reads the file and one test cannot leak config into the next.
 *
 * WRITES ARE SERIALISED. Two commits in the same tick (a row that owns two keys
 * is one `patchMany`; two different rows clicked quickly are two) would race for
 * the same token, so commits queue behind one another and each is sent with the
 * version the previous one produced.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type {
  CodexConfigEdit,
  CodexConfigRead,
  CodexConfigSnapshot,
  CodexConfigValue,
  CodexConfigWriteResult,
  CodexRulesStatus
} from '../../../../shared/codex-types'

export type CodexLeafPath = string[]

/** Stable string form of a path — the `keyPath` the binary parses, and the row's testid. */
export const codexPathId = (path: CodexLeafPath): string => path.join('.')

function readLeaf(root: unknown, path: CodexLeafPath): CodexConfigValue | undefined {
  let cur: unknown = root
  for (const segment of path) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[segment]
  }
  return cur === undefined ? undefined : (cur as CodexConfigValue)
}

interface CodexConfigState {
  /** null until the first read resolves — panes render a Loading row. */
  read: CodexConfigRead | null
  /** Per-key-path write failures, shown inline on the row that caused them. */
  errors: Record<string, string>
  /** One-shot notice after a version conflict; the page clears it. */
  notice: string | null
}

interface Entry extends CodexConfigState {
  listeners: Set<() => void>
  /** The tail of the write queue — commits chain onto it. */
  queue: Promise<unknown>
  /**
   * Key paths with a write already QUEUED, and the value that write will leave.
   *
   * Without it, two clicks on one row before the first re-read both compute
   * their "next" value against the SAME stale snapshot, so the second either
   * repeats the first (a pointless write and version bump) or, worse, cancels
   * it out and leaves the file on the value the user just turned off. A queued
   * edit is part of what the file is about to hold, so it counts as the current
   * value for the no-op check.
   */
  pending: Map<string, CodexConfigValue | null>
}

let ENTRY: Entry | null = null

const emit = (entry: Entry): void => {
  for (const listener of entry.listeners) listener()
}

/**
 * Publish a new state object. Every field is replaced together so the snapshot
 * identity changes exactly once per update — `useSyncExternalStore` compares by
 * identity and would loop on a fresh object returned from a plain getter.
 */
function set(entry: Entry, patch: Partial<CodexConfigState>): void {
  if (ENTRY !== entry) return // a late resolve for a discarded entry
  Object.assign(entry, patch)
  snapshotOf(entry, true)
  emit(entry)
}

/** The memoised public snapshot; recomputed only when `set` says so. */
const SNAPSHOTS = new WeakMap<Entry, CodexConfigState>()
function snapshotOf(entry: Entry, refresh = false): CodexConfigState {
  const cached = SNAPSHOTS.get(entry)
  if (cached && !refresh) return cached
  const next: CodexConfigState = { read: entry.read, errors: entry.errors, notice: entry.notice }
  SNAPSHOTS.set(entry, next)
  return next
}

function load(entry: Entry): Promise<void> {
  return window.api
    .readCodexConfig()
    .then((read) => set(entry, { read }))
    .catch((error: unknown) =>
      set(entry, {
        read: {
          config: null,
          rules: { path: '', rules: 0, skipped: 0, syncedAt: null, upToDate: false },
          mcp: { inherited: [], skipped: [] },
          error: error instanceof Error ? error.message : String(error)
        }
      })
    )
}

function entry(): Entry {
  if (ENTRY) return ENTRY
  const created: Entry = {
    read: null,
    errors: {},
    notice: null,
    listeners: new Set(),
    queue: Promise.resolve(),
    pending: new Map()
  }
  ENTRY = created
  created.queue = load(created)
  return created
}

function subscribe(listener: () => void): () => void {
  const current = entry()
  current.listeners.add(listener)
  return () => {
    current.listeners.delete(listener)
    // Last one out drops the entry, so the next open re-reads the file.
    if (current.listeners.size === 0 && ENTRY === current) ENTRY = null
  }
}

/** Read during render, so it must NOT create the entry and must be stable. */
function getSnapshot(): CodexConfigState | null {
  return ENTRY ? snapshotOf(ENTRY) : null
}

const EMPTY: CodexConfigState = { read: null, errors: {}, notice: null }

/** Enqueue one write behind whatever is already in flight. */
function commit(current: Entry, edits: CodexConfigEdit[]): void {
  const ids = edits.map((edit) => edit.keyPath)
  for (const edit of edits) current.pending.set(edit.keyPath, edit.value)
  const settled = (): void => {
    for (const [index, id] of ids.entries()) {
      // Only drop the reservation this commit made: a LATER click on the same
      // row has already replaced it, and that one is still in flight.
      if (current.pending.get(id) === edits[index].value) current.pending.delete(id)
    }
  }
  const fail = (message: string): void => {
    if (ENTRY !== current) return
    const errors = { ...current.errors }
    for (const id of ids) errors[id] = message
    set(current, { errors })
  }
  current.queue = current.queue
    .then(async () => {
      if (ENTRY !== current) return settled()
      const version = current.read?.config?.version
      if (!version) return settled()
      let result: CodexConfigWriteResult
      try {
        result = await window.api.writeCodexConfig(edits, version)
      } catch {
        result = { status: 'unavailable' }
      }
      if (ENTRY !== current) return settled()
      if (result.status === 'ok') {
        const errors = { ...current.errors }
        for (const id of ids) delete errors[id]
        // The write already carries the config as it stands after it, read on
        // the same app-server child — so folding it in is the re-read, and a
        // second `codex-config:read` here would be a second process start for
        // a state we already hold. `rules` and `mcp` are untouched: neither is
        // a function of `config.toml`, and neither can have changed because of
        // this write.
        set(current, {
          errors,
          read: current.read ? { ...current.read, config: result.snapshot } : current.read
        })
        settled()
        return
      }
      // Released BEFORE the conflict re-read below: the notice tells the user to
      // try again, and a click during that read must not be dropped as a
      // repeat of the value this commit failed to write.
      settled()
      if (result.status === 'version-conflict') {
        // Not the user's mistake: the file moved under us (a terminal, another
        // window). Re-read so the NEXT write carries a live token, and say so
        // once rather than reporting a failure on the row.
        await load(current)
        set(current, {
          notice: 'config.toml changed outside ClaudeUI — reloaded. Try that change again.'
        })
        return
      }
      fail(
        result.status === 'refused'
          ? result.message
          : 'Codex is unavailable, so the change was not written.'
      )
    })
    // Every later commit chains onto THIS promise. A throw anywhere above — a
    // malformed result, a bug in the folding — must therefore land on the row
    // and leave the queue resolved, or one bad write would silently swallow
    // every click after it (which is exactly what the 2026-09-14 drive saw).
    .catch((error: unknown) => {
      settled()
      fail(error instanceof Error ? error.message : String(error))
    })
}

export interface CodexConfigApi {
  /** 'loading' until the first read lands; 'unavailable' when there is no config. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Why the page is unavailable, when it is. */
  unavailable: string | null
  snapshot: CodexConfigSnapshot | null
  rules: CodexRulesStatus | null
  mcp: { inherited: string[]; skipped: string[] }
  /** The value in the USER layer, or undefined when the key is not set there. */
  read: (path: CodexLeafPath) => CodexConfigValue | undefined
  /** The merged value across every layer — what a blank row falls back to. */
  effective: (path: CodexLeafPath) => CodexConfigValue | undefined
  /** ADR-065's "changed from default": the key is PRESENT in the user layer. */
  modified: (path: CodexLeafPath) => boolean
  /** Set one key; `undefined` REMOVES it (probe (c)). */
  patch: (path: CodexLeafPath, value: CodexConfigValue | undefined) => void
  /** Set several keys in ONE write — a row that owns more than one key. */
  patchMany: (entries: Array<{ path: CodexLeafPath; value?: CodexConfigValue }>) => void
  errorAt: (path: CodexLeafPath) => string | null
  notice: string | null
  dismissNotice: () => void
  reload: () => void
  recompileRules: () => void
}

export function useCodexConfig(): CodexConfigApi {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) ?? EMPTY
  const read = state.read

  const leaf = useCallback((path: CodexLeafPath) => readLeaf(read?.config?.user, path), [read])
  const effective = useCallback(
    (path: CodexLeafPath) => readLeaf(read?.config?.effective, path),
    [read]
  )
  const patchMany = useCallback(
    (entries: Array<{ path: CodexLeafPath; value?: CodexConfigValue }>) => {
      const current = ENTRY
      if (!current) return
      const edits = entries
        // A commit that would not change the file is dropped, so a blur without
        // an edit never touches `config.toml` — and never burns a version. A
        // QUEUED edit counts as the current value (see `Entry.pending`).
        .filter((item) => {
          const key = codexPathId(item.path)
          const current_ = current.pending.has(key)
            ? current.pending.get(key)
            : readLeaf(current.read?.config?.user, item.path)
          return JSON.stringify(current_ ?? null) !== JSON.stringify(item.value ?? null)
        })
        .map((item) => ({ keyPath: codexPathId(item.path), value: item.value ?? null }))
      if (edits.length > 0) commit(current, edits)
    },
    []
  )

  return {
    status: read === null ? 'loading' : read.config ? 'ready' : 'unavailable',
    unavailable: read?.config ? null : (read?.error ?? null),
    snapshot: read?.config ?? null,
    rules: read?.rules ?? null,
    mcp: read?.mcp ?? { inherited: [], skipped: [] },
    read: leaf,
    effective,
    modified: useCallback((path: CodexLeafPath) => leaf(path) !== undefined, [leaf]),
    patch: useCallback(
      (path: CodexLeafPath, value: CodexConfigValue | undefined) => patchMany([{ path, value }]),
      [patchMany]
    ),
    patchMany,
    errorAt: useCallback(
      (path: CodexLeafPath) => state.errors[codexPathId(path)] ?? null,
      [state.errors]
    ),
    notice: state.notice,
    dismissNotice: useCallback(() => {
      if (ENTRY) set(ENTRY, { notice: null })
    }, []),
    reload: useCallback(() => {
      const current = ENTRY
      if (current) current.queue = current.queue.then(() => load(current))
    }, []),
    recompileRules: useCallback(() => {
      const current = ENTRY
      if (!current) return
      current.queue = current.queue.then(async () => {
        const rules = await window.api.recompileCodexRules().catch(() => null)
        if (!rules || ENTRY !== current || !current.read) return
        set(current, { read: { ...current.read, rules } })
      })
    }, [])
  }
}

/** Test seam: drop the shared entry so one suite cannot leak into the next. */
export function resetCodexConfigStore(): void {
  ENTRY = null
}
