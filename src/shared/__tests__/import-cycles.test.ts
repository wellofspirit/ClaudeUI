/**
 * @vitest-environment node
 *
 * Static value-import cycles in non-test source. A cycle makes module
 * evaluation order depend on who is imported first, and it silently widens the
 * graph a spec's `vi.mock` has to cut (the nine-file services cycle through
 * `usage-fetcher` -> `claude-session` was found that way).
 *
 * The set of cycles must EQUAL KNOWN_CYCLES: a new cycle, a known cycle that
 * grew or shrank, and a known cycle that is gone each fail. Type-only imports
 * and dynamic `import()` are not edges (see `staticValueImports`).
 */

import { describe, it, expect } from 'vitest'
import {
  isTestFile,
  listSourceFiles,
  readSource,
  resolveSpecifier,
  staticValueImports
} from '../../test/helpers/source-graph'

/** Sorted member list + why the cycle stays. */
const KNOWN_CYCLES: ReadonlyArray<{ members: readonly string[]; reason: string }> = [
  {
    members: [
      'src/renderer/src/components/SessionView.tsx',
      'src/renderer/src/components/chat/AuthPill.tsx',
      'src/renderer/src/components/chat/ChatPanel/ChatPanel.tsx',
      'src/renderer/src/components/chat/ChatPanel/TopBar.tsx',
      'src/renderer/src/components/chat/ChatPanel/index.ts'
    ],
    reason:
      'AuthPill and TopBar import useSidebarCollapsed from SessionView; breaking it means moving the sidebar context to its own module'
  },
  {
    members: ['src/renderer/src/stores/replica.ts', 'src/renderer/src/stores/session-store.ts'],
    reason:
      'by design: the store imports the replica for its sanctioned local writes (session-store.ts:103)'
  },
  {
    members: [
      'src/core/services/sync-host.ts',
      'src/core/services/ui-config.ts',
      'src/core/services/worktree-detect.ts'
    ],
    reason:
      'ui-config emits through the sync-host funnel (its file watcher); breaking it means injecting the emitter'
  },
  {
    members: [
      'src/core/auth/PiAuthProvider.ts',
      'src/core/pi/history-status-line.ts',
      'src/core/pi/message-cost.ts',
      'src/core/services/pi-session-list.ts'
    ],
    reason:
      'PiAuthProvider takes piAgentDir from pi-session-list; breaking it means moving that function to a leaf module and repointing the mocks of six specs'
  }
]

function buildGraph(): { graph: Map<string, string[]>; files: number; edges: number } {
  const files = listSourceFiles().filter((f) => !isTestFile(f))
  const known = new Set(files)
  const graph = new Map<string, string[]>()
  let edges = 0
  for (const f of files) {
    const targets = new Set<string>()
    for (const spec of staticValueImports(readSource(f))) {
      const to = resolveSpecifier(f, spec)
      // `known` drops assets (.css, .json, .png) that resolve but are not source nodes
      if (to && to !== f && known.has(to)) targets.add(to)
    }
    graph.set(f, [...targets].sort())
    edges += targets.size
  }
  return { graph, files: files.length, edges }
}

/** Tarjan, iterative (the graph is deep enough to make recursion a risk). */
function cyclicComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0

  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }]
    index.set(root, counter)
    low.set(root, counter++)
    stack.push(root)
    onStack.add(root)
    while (work.length) {
      const frame = work[work.length - 1]
      const succ = graph.get(frame.node) ?? []
      if (frame.next < succ.length) {
        const w = succ[frame.next++]
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter++)
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, next: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
        } while (w !== frame.node)
        if (comp.length > 1) out.push(comp.sort())
      }
    }
  }
  return out
}

/** One concrete chain `a -> b -> … -> a` inside the component (BFS back to the first member). */
function chainAround(graph: Map<string, string[]>, members: string[]): string {
  const inside = new Set(members)
  const start = members[0]
  const prev = new Map<string, string>()
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of graph.get(cur) ?? []) {
      if (!inside.has(next)) continue
      if (next === start) {
        const path = [start]
        for (let n = cur; n !== start; n = prev.get(n)!) path.splice(1, 0, n)
        return [...path, start].join(' -> ')
      }
      if (!prev.has(next)) {
        prev.set(next, cur)
        queue.push(next)
      }
    }
  }
  return `(no chain found from ${start})`
}

const key = (members: readonly string[]): string => members.join('\n')

describe('static value-import cycles', () => {
  const { graph, files, edges } = buildGraph()
  const found = cyclicComponents(graph)

  it('scans a real graph (non-vacuity)', () => {
    expect(files).toBeGreaterThan(900)
    expect(edges).toBeGreaterThan(3000)
  })

  it('has exactly the known cycles', () => {
    const known = new Map(KNOWN_CYCLES.map((c) => [key(c.members), c]))
    const seen = new Set(found.map(key))
    const problems: string[] = []

    for (const members of found) {
      if (known.has(key(members))) continue
      // A known cycle with a different member set that overlaps this one has changed shape.
      const overlap = KNOWN_CYCLES.find((c) => c.members.some((m) => members.includes(m)))
      problems.push(
        `${overlap ? 'Known cycle CHANGED' : 'NEW import cycle'} (${members.length} files):\n` +
          members.map((m) => `    ${m}`).join('\n') +
          `\n  one chain: ${chainAround(graph, members)}\n` +
          (overlap
            ? `  it overlaps the known cycle "${overlap.reason}"; break the new edge, or update the KNOWN_CYCLES entry if the change is deliberate.`
            : '  break it: if an import on the chain is used only as a type, write `import type` (the scan counts every other import as a value edge); otherwise move the shared symbol to a leaf module, or make the back edge a lazy import().')
      )
    }
    for (const c of KNOWN_CYCLES) {
      if (seen.has(key(c.members))) continue
      if (found.some((f) => f.some((m) => c.members.includes(m)))) continue // reported as CHANGED above
      problems.push(
        `Known cycle no longer exists (${c.reason}):\n` +
          c.members.map((m) => `    ${m}`).join('\n') +
          '\n  delete its entry from KNOWN_CYCLES.'
      )
    }
    if (problems.length) throw new Error('\n' + problems.join('\n\n'))
  })
})
