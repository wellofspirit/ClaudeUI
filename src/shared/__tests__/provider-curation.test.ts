/**
 * Unit tests for provider-curation (ADR-074 §3): the effective curation of a
 * shared definition, and the canonical ↔ engine id translation both the Manage
 * sheet and `SharedProviderService.setCuration` use.
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalModelId,
  curationForEngine,
  effectiveCuration,
  engineModelId
} from '../provider-curation'
import type { SharedProviderModel } from '../shared-provider'

const plain = { models: [] as SharedProviderModel[] }
const custom = {
  models: [
    { id: 'big', harnessOverrides: { opencode: { id: 'oc-big' }, pi: { id: 'pi-big' } } },
    { id: 'small' }
  ] as SharedProviderModel[]
}

describe('effectiveCuration', () => {
  it('a stored record wins over whatever the engines hold', () => {
    expect(
      effectiveCuration({ ...plain, curation: { linked: false } }, { opencode: ['a'], pi: ['a'] })
    ).toEqual({ linked: false })
  })

  it('no record: both on All is one list on All', () => {
    expect(effectiveCuration(plain, {})).toEqual({ linked: true })
  })

  it('no record: equal lists are one list, in any order', () => {
    expect(effectiveCuration(plain, { opencode: ['a', 'b'], pi: ['b', 'a'] })).toEqual({
      linked: true,
      models: ['a', 'b']
    })
  })

  it('no record: different lists, or one on All, are separate', () => {
    expect(effectiveCuration(plain, { opencode: ['a'], pi: ['a', 'b'] })).toEqual({
      linked: false
    })
    expect(effectiveCuration(plain, { opencode: ['a'] })).toEqual({ linked: false })
  })

  it('compares a custom provider in canonical ids, through each engine’s override', () => {
    expect(effectiveCuration(custom, { opencode: ['oc-big'], pi: ['pi-big'] })).toEqual({
      linked: true,
      models: ['big']
    })
    expect(effectiveCuration(custom, { opencode: ['oc-big'], pi: ['small'] })).toEqual({
      linked: false
    })
  })
})

describe('id translation', () => {
  it('maps canonical → engine through the override, identity otherwise, and back', () => {
    expect(engineModelId(custom, 'opencode', 'big')).toBe('oc-big')
    expect(engineModelId(custom, 'pi', 'big')).toBe('pi-big')
    expect(engineModelId(custom, 'pi', 'small')).toBe('small')
    expect(engineModelId(plain, 'pi', 'gpt-5.5')).toBe('gpt-5.5')
    expect(canonicalModelId(custom, 'pi', 'pi-big')).toBe('big')
    expect(canonicalModelId(custom, 'opencode', 'unknown')).toBe('unknown')
  })

  it('curationForEngine: that engine’s ids, null for All', () => {
    expect(
      curationForEngine(custom, { linked: true, models: ['big', 'small'] }, 'opencode')
    ).toEqual(['oc-big', 'small'])
    expect(curationForEngine(custom, { linked: true }, 'pi')).toBeNull()
  })
})
