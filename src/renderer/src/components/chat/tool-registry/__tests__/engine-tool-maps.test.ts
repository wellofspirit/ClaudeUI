/**
 * Unit tests for engineToolMap — the engineId → EngineToolMap registry lookup.
 *
 * Regression guard for the `satisfies Record<EngineId, …>` table: every
 * EngineId must resolve to its own tool map, not silently fall back to
 * Claude's.
 */

import { describe, it, expect } from 'vitest'
import { engineToolMap } from '../engine-tool-maps'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { CodexEngineToolMap } from '../CodexEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'
import type { EngineId } from '../../../../../../shared/types'

describe('engineToolMap', () => {
  it('resolves claude to ClaudeEngineToolMap', () => {
    expect(engineToolMap('claude')).toBe(ClaudeEngineToolMap)
  })

  it('resolves opencode to OpencodeEngineToolMap', () => {
    expect(engineToolMap('opencode')).toBe(OpencodeEngineToolMap)
  })

  it('resolves pi to PiEngineToolMap', () => {
    expect(engineToolMap('pi')).toBe(PiEngineToolMap)
  })

  it('has a defined tool map for every EngineId', () => {
    const ids: EngineId[] = ['claude', 'opencode', 'pi']
    for (const id of ids) {
      expect(engineToolMap(id)).toBeTruthy()
    }
  })
})

// Identical in every engine's map: the dispatch card is a background card only
// on an explicit `run_in_background: true`.
describe.each([
  ['Claude', ClaudeEngineToolMap],
  ['Codex', CodexEngineToolMap],
  ['Opencode', OpencodeEngineToolMap],
  ['Pi', PiEngineToolMap]
] as const)('%sEngineToolMap — dispatch run_in_background', (_name, map) => {
  it('marks the dispatch card background; absent or false leaves it a waiting call', () => {
    const view = (extra: Record<string, unknown>) =>
      map.normalize('task', { engine: 'claude', prompt: 'x', ...extra })
    expect(view({ run_in_background: true })).toMatchObject({ kind: 'task', background: true })
    expect(view({ run_in_background: false })).not.toHaveProperty('background')
    expect(view({})).not.toHaveProperty('background')
  })
})
