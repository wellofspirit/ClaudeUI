/**
 * @vitest-environment node
 *
 * The app-settings schema's read rule. `resolveAppSetting` is what core reads
 * every setting through (`appSetting`), so these cases are what a settings.json
 * written by an older build, a newer build or a hand edit resolves to.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, resolveAppSetting, sessionToolsEnabled } from '../app-settings'

describe('resolveAppSetting', () => {
  it('returns the saved value of a key the document has', () => {
    const saved = { usageRefreshSecs: 300, mockupAllowHttp: true, logLevel: 'debug' }
    expect(resolveAppSetting(saved, 'usageRefreshSecs')).toBe(300)
    expect(resolveAppSetting(saved, 'mockupAllowHttp')).toBe(true)
    expect(resolveAppSetting(saved, 'logLevel')).toBe('debug')
  })

  it('keeps a saved falsy value instead of the default', () => {
    const saved = { sessionTimeoutMins: 0, showAgentPill: false, statusLineTemplate: '' }
    expect(resolveAppSetting(saved, 'sessionTimeoutMins')).toBe(0)
    expect(resolveAppSetting(saved, 'showAgentPill')).toBe(false)
    expect(resolveAppSetting(saved, 'statusLineTemplate')).toBe('')
  })

  it('gives a key the document lacks its default (a document an older build wrote)', () => {
    const olderBuild = { theme: 'light' }
    expect(resolveAppSetting(olderBuild, 'usageRefreshSecs')).toBe(
      DEFAULT_SETTINGS.usageRefreshSecs
    )
    expect(resolveAppSetting(olderBuild, 'agentModelTierColors')).toBe(true)
    expect(resolveAppSetting(olderBuild, 'theme')).toBe('light')
  })

  it('gives every key its default when nothing was ever saved', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
      expect(resolveAppSetting({}, key)).toBe(DEFAULT_SETTINGS[key])
      expect(resolveAppSetting(undefined, key)).toBe(DEFAULT_SETTINGS[key])
      expect(resolveAppSetting(null, key)).toBe(DEFAULT_SETTINGS[key])
    }
  })

  it('replaces a value of the wrong type with the default (a hand edit)', () => {
    const handEdited = {
      usageRefreshSecs: 'fast',
      mockupAllowHttp: 'yes',
      logFilter: 7,
      modelEffortDefaults: null
    }
    expect(resolveAppSetting(handEdited, 'usageRefreshSecs')).toBe(120)
    expect(resolveAppSetting(handEdited, 'mockupAllowHttp')).toBe(false)
    expect(resolveAppSetting(handEdited, 'logFilter')).toBe('')
    expect(resolveAppSetting(handEdited, 'modelEffortDefaults')).toBe(
      DEFAULT_SETTINGS.modelEffortDefaults
    )
  })

  it('returns a key with no default as saved, and undefined when unset', () => {
    expect(resolveAppSetting({}, 'dispatchMaxConcurrent')).toBeUndefined()
    expect(resolveAppSetting({ dispatchMaxConcurrent: 0 }, 'dispatchMaxConcurrent')).toBe(0)
    expect(resolveAppSetting({}, 'sessionTools')).toBeUndefined()
    expect(resolveAppSetting({ sessionTools: false }, 'sessionTools')).toBe(false)
  })
})

describe('sessionToolsEnabled', () => {
  it('is on when unset and off only for an explicit false', () => {
    expect(sessionToolsEnabled({})).toBe(true)
    expect(sessionToolsEnabled({ sessionTools: true })).toBe(true)
    expect(sessionToolsEnabled({ sessionTools: false })).toBe(false)
  })
})
