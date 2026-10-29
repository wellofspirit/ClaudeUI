import { describe, it, expect } from 'vitest'
import { engineLabelOf, isEngineId } from '../engine-label'
import { engineMeta } from '../engine-meta'
import { ENGINE_IDS } from '../types'

describe('isEngineId', () => {
  it('accepts exactly the engines this build runs', () => {
    for (const id of ENGINE_IDS) expect(isEngineId(id)).toBe(true)
  })

  it('rejects the retired codex engine and anything that is not a string', () => {
    expect(isEngineId('codex')).toBe(false)
    expect(isEngineId('')).toBe(false)
    expect(isEngineId(undefined)).toBe(false)
    expect(isEngineId(null)).toBe(false)
    expect(isEngineId(3)).toBe(false)
    // Own-property lookups only: a prototype key is not an engine.
    expect(isEngineId('toString')).toBe(false)
  })
})

describe('engineLabelOf', () => {
  it('uses the engine registry label for a live engine', () => {
    for (const id of ENGINE_IDS) expect(engineLabelOf(id)).toBe(engineMeta(id).label)
    expect(engineLabelOf('claude')).toBe(engineMeta('claude').label)
  })

  it('labels a historical codex row instead of throwing', () => {
    expect(engineLabelOf('codex')).toBe('Codex (removed)')
  })

  it('shows any other unknown engine string as it is, and a blank one as unknown', () => {
    expect(engineLabelOf('some-future-engine')).toBe('some-future-engine')
    expect(engineLabelOf('')).toBe('Unknown engine')
  })
})
