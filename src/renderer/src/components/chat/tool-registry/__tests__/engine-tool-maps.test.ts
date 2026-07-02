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
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import type { EngineId } from '../../../../../../shared/types'

describe('engineToolMap', () => {
  it('resolves claude to ClaudeEngineToolMap', () => {
    expect(engineToolMap('claude')).toBe(ClaudeEngineToolMap)
  })

  it('resolves opencode to OpencodeEngineToolMap', () => {
    expect(engineToolMap('opencode')).toBe(OpencodeEngineToolMap)
  })

  it('has a defined tool map for every EngineId', () => {
    const ids: EngineId[] = ['claude', 'opencode']
    for (const id of ids) {
      expect(engineToolMap(id)).toBeTruthy()
    }
  })
})
