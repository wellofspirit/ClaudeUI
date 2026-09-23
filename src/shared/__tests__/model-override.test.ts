/**
 * Unit tests for effectiveModelOverride (ADR-074 §9).
 *
 * The guarantee: pin and rename are independent switches, and a file written
 * before they existed — `enabled` alone — keeps setting all four env vars.
 */
import { describe, it, expect } from 'vitest'
import { effectiveModelOverride } from '../model-override'

const FIELDS = { model: 'x', sonnetModel: 's', opusModel: 'o', haikuModel: '' }

describe('effectiveModelOverride', () => {
  it('a legacy enabled:true config pins AND renames', () => {
    expect(effectiveModelOverride({ enabled: true, ...FIELDS })).toEqual({
      pin: 'x',
      sonnet: 's',
      opus: 'o',
      haiku: null
    })
  })

  it('a legacy enabled:false config does nothing', () => {
    expect(effectiveModelOverride({ enabled: false, ...FIELDS })).toEqual({
      pin: null,
      sonnet: null,
      opus: null,
      haiku: null
    })
  })

  it('pin only sets the model and leaves every alias alone', () => {
    expect(
      effectiveModelOverride({ enabled: true, pinEnabled: true, renameEnabled: false, ...FIELDS })
    ).toEqual({ pin: 'x', sonnet: null, opus: null, haiku: null })
  })

  it('rename only sets the aliases and never pins', () => {
    expect(
      effectiveModelOverride({ enabled: true, pinEnabled: false, renameEnabled: true, ...FIELDS })
    ).toEqual({ pin: null, sonnet: 's', opus: 'o', haiku: null })
  })

  it('an explicit flag wins over the legacy one in both directions', () => {
    // enabled:false from an older build's write does not switch off a job the
    // new flag turns on.
    expect(effectiveModelOverride({ enabled: false, pinEnabled: true, ...FIELDS }).pin).toBe('x')
    expect(effectiveModelOverride({ enabled: false, pinEnabled: true, ...FIELDS }).sonnet).toBe(
      null
    )
  })

  it('an empty pinned model is not a pin', () => {
    expect(effectiveModelOverride({ enabled: true, pinEnabled: true, model: '' }).pin).toBeNull()
  })

  it('no config is no override', () => {
    expect(effectiveModelOverride(undefined)).toEqual({
      pin: null,
      sonnet: null,
      opus: null,
      haiku: null
    })
  })
})
