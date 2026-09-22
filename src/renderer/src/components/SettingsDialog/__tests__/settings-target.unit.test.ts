import { describe, it, expect } from 'vitest'
import { SETTINGS_PAGE_IDS, settingsTargetFromEvent } from '../settings-target'
import { PAGES } from '../settings-pages'

const openSettings = (detail?: unknown): Event => new CustomEvent('open-settings', { detail })

describe('settingsTargetFromEvent', () => {
  it('passes a known page and its group through', () => {
    expect(settingsTargetFromEvent(openSettings({ page: 'models', group: 'providers' }))).toEqual({
      page: 'models',
      group: 'providers'
    })
  })

  it('reads the bare form as "just open Settings"', () => {
    expect(settingsTargetFromEvent(openSettings())).toBeUndefined()
    expect(settingsTargetFromEvent(openSettings({ group: 'providers' }))).toBeUndefined()
  })

  it('an UNKNOWN page is no target — the page lookup throws from inside render', () => {
    // `general` is not a page. As a target it reached `pageById`, which throws,
    // and the top-level error boundary replaced the whole window.
    expect(settingsTargetFromEvent(openSettings({ page: 'general' }))).toBeUndefined()
    expect(settingsTargetFromEvent(openSettings({ page: 42 }))).toBeUndefined()
  })

  it('drops a group that is not a string rather than navigating with it', () => {
    expect(settingsTargetFromEvent(openSettings({ page: 'models', group: 7 }))).toEqual({
      page: 'models',
      group: undefined
    })
  })
})

describe('SETTINGS_PAGE_IDS', () => {
  it('is exactly the pages that exist — the guard above is only as good as this list', () => {
    expect([...SETTINGS_PAGE_IDS].sort()).toEqual(PAGES.map((page) => page.id).sort())
  })
})
