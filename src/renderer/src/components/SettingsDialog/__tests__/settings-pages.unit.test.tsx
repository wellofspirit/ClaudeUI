/**
 * Layer 1: the settings PAGE model (ADR-065).
 *
 * The load-bearing test here is the INVENTORY GUARD. The redesign re-homes 43
 * sections' worth of settings into 11 pages by hand; the failure mode is not a
 * crash but a setting that quietly stops having a home — unreachable in the UI,
 * still written in the config file. So the guard asserts an exact bijection:
 * every item key reachable from `PAGES` is either a key of some `SECTIONS`
 * entry or one of the three rows this model defines itself, each appearing
 * exactly once (a `byEngine` group counts one per engine list).
 */
import { describe, it, expect } from 'vitest'
import { SECTIONS } from '../settings-sections'
import {
  PAGES,
  PAGE_LOCAL_ITEMS,
  RAIL_GROUPS,
  SECTION_TARGET,
  enginesOf,
  pageOf,
  searchSettings,
  storageOf,
  targetToLegacy,
  visibleGroups,
  type SettingsGroup
} from '../settings-pages'
import type { EngineCapabilities } from '../../../../../shared/model-capabilities'

/** Every item a group can render, across every engine list it declares. */
function allItemsOf(group: SettingsGroup): Array<{ key: string; engine?: string }> {
  if (group.items) return group.items.map((i) => ({ key: i.key }))
  return enginesOf(group).flatMap((engine) =>
    (group.byEngine?.[engine] ?? []).map((i) => ({ key: i.key, engine }))
  )
}

describe('PAGES structure', () => {
  it('has the 11 documented pages, in order', () => {
    expect(PAGES.map((p) => p.id)).toEqual([
      'appearance',
      'chat',
      'sessions',
      'advanced',
      'models',
      'dispatch',
      'mockups',
      'remote',
      'claude',
      'opencode',
      'pi'
    ])
  })

  it('has 3 rail groups and every page belongs to one', () => {
    expect(RAIL_GROUPS.map((g) => g.id)).toEqual(['app', 'features', 'engines'])
    const ids = new Set(RAIL_GROUPS.map((g) => g.id))
    for (const page of PAGES) expect(ids.has(page.rail)).toBe(true)
  })

  it('rail membership matches ADR-065 (App / Features / Engines)', () => {
    const byRail = (rail: string): string[] => PAGES.filter((p) => p.rail === rail).map((p) => p.id)
    expect(byRail('app')).toEqual(['appearance', 'chat', 'sessions', 'advanced'])
    expect(byRail('features')).toEqual(['models', 'dispatch', 'mockups', 'remote'])
    expect(byRail('engines')).toEqual(['claude', 'opencode', 'pi'])
  })

  it('only the Engines pages declare an engine', () => {
    for (const page of PAGES) {
      if (page.rail === 'engines') expect(page.engine).toBe(page.id)
      else expect(page.engine).toBeUndefined()
    }
  })

  it('every page has a title and a one-line description', () => {
    for (const page of PAGES) {
      expect(page.label.length).toBeGreaterThan(0)
      expect(page.description.length).toBeGreaterThan(0)
    }
  })

  it('each page lists its groups in the documented order', () => {
    const expected: Record<string, string[]> = {
      appearance: ['theme', 'layout', 'diff', 'status-line', 'git-panel'],
      chat: ['tool-output', 'thinking', 'voice', 'git-actions'],
      sessions: ['autonomy', 'permissions', 'judge', 'trust', 'retention'],
      advanced: ['logging', 'usage', 'about'],
      models: [
        'providers',
        'providers-opencode',
        'providers-pi',
        'defaults',
        'pi-fallbacks',
        'anthropic',
        'accounts'
      ],
      dispatch: ['into'],
      mockups: ['network'],
      remote: ['follow', 'server', 'access', 'security', 'links'],
      claude: ['sandbox', 'proxy'],
      opencode: [
        'session',
        'tool-output',
        'attachments',
        'workspace',
        'tools',
        'diagnostics',
        'managed',
        'agents',
        'raw'
      ],
      pi: ['session', 'retry', 'tools', 'attachments', 'workspace', 'resources', 'network', 'raw']
    }
    for (const page of PAGES) expect(page.groups.map((g) => g.id)).toEqual(expected[page.id])
  })

  it('engine-native groups say when they apply, with the three-value badge vocabulary', () => {
    for (const g of pageOf('opencode').groups) {
      if (g.id === 'managed' || g.id === 'agents') continue
      expect(g.appliesOn, `opencode/${g.id}`).toBe('next-server-start')
      expect(g.note, `opencode/${g.id}`).toBeTruthy()
    }
    for (const g of pageOf('pi').groups) {
      expect(g.appliesOn, `pi/${g.id}`).toBe('next-session')
      expect(g.note, `pi/${g.id}`).toBeTruthy()
    }
    for (const g of pageOf('claude').groups) expect(g.appliesOn).toBe('next-session')
    // ClaudeUI's own settings apply at once — no badge, no note.
    for (const g of pageOf('appearance').groups) expect(g.appliesOn).toBeUndefined()
  })

  it('group ids are unique within their page', () => {
    for (const page of PAGES) {
      const ids = page.groups.map((g) => g.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('a group declares exactly one of items / byEngine', () => {
    for (const page of PAGES) {
      for (const group of page.groups) {
        expect(Boolean(group.items) !== Boolean(group.byEngine)).toBe(true)
      }
    }
  })

  it('byEngine groups list their engines in claude → opencode → pi order', () => {
    expect(enginesOf(pageOf('sessions').groups[2])).toEqual(['opencode', 'pi'])
    expect(enginesOf(pageOf('models').groups[3])).toEqual(['claude', 'opencode', 'pi'])
    expect(enginesOf(pageOf('dispatch').groups[0])).toEqual(['claude', 'opencode'])
  })

  it('a per-engine storage tag resolves against the selected engine', () => {
    const judge = pageOf('sessions').groups[2]
    expect(storageOf(judge, 'opencode')).toBe('engines/opencode.json')
    expect(storageOf(judge, 'pi')).toBe('engines/pi.json')
    // A fixed tag ignores the engine.
    expect(
      storageOf(
        pageOf('models').groups.find((g) => g.id === 'anthropic')!,
        'claude'
      )
    ).toBe('vendors/anthropic.json')
    // No tag = the group writes ClaudeUI's own settings.json.
    expect(storageOf(pageOf('appearance').groups[0], undefined)).toBeUndefined()
  })
})

describe('inventory guard', () => {
  it('every SECTIONS item has exactly one home in PAGES, and nothing else appears', () => {
    const reachable = PAGES.flatMap((p) => p.groups.flatMap(allItemsOf)).map((i) => i.key)

    // No key is rendered twice (a byEngine group contributes one per engine, so
    // the SAME key twice would mean a genuine duplicate home).
    const seen = new Map<string, number>()
    for (const key of reachable) seen.set(key, (seen.get(key) ?? 0) + 1)
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    expect(duplicated).toEqual([])

    const fromSections = SECTIONS.flatMap((s) => s.items.map((i) => i.key))
    const local = PAGE_LOCAL_ITEMS.map((i) => i.key)
    expect(local).toEqual(['sandboxCrossLink', 'otherEnginePermissions', 'versions'])

    expect([...reachable].sort()).toEqual([...fromSections, ...local].sort())
  })

  it('reaches the very same SettingItem objects — no re-implemented bodies', () => {
    const bySection = new Set(SECTIONS.flatMap((s) => s.items))
    const localSet = new Set(PAGE_LOCAL_ITEMS)
    for (const page of PAGES) {
      for (const group of page.groups) {
        const items = group.items ?? enginesOf(group).flatMap((e) => group.byEngine?.[e] ?? [])
        for (const item of items) {
          expect(bySection.has(item) || localSet.has(item)).toBe(true)
        }
      }
    }
  })
})

describe('SECTION_TARGET', () => {
  it('files every legacy section under an existing page and group', () => {
    for (const section of SECTIONS) {
      const target = SECTION_TARGET[section.id]
      expect(target, `no SECTION_TARGET for "${section.id}"`).toBeDefined()
      const page = pageOf(target.page)
      expect(
        page.groups.some((g) => g.id === target.group),
        `page "${target.page}" has no group "${target.group}"`
      ).toBe(true)
    }
  })

  it('names no section that does not exist', () => {
    const known = new Set(SECTIONS.map((s) => s.id))
    for (const id of Object.keys(SECTION_TARGET)) expect(known.has(id)).toBe(true)
  })

  it('routes the four deep links the app actually fires', () => {
    expect(SECTION_TARGET.sandbox).toEqual({ page: 'claude', group: 'sandbox' })
    expect(SECTION_TARGET.remote).toEqual({ page: 'remote', group: 'server' })
    expect(SECTION_TARGET['shared-providers']).toEqual({ page: 'models', group: 'providers' })
    expect(SECTION_TARGET.permissions).toEqual({ page: 'sessions', group: 'permissions' })
  })
})

describe('visibleGroups', () => {
  it('keeps every group when the engine has the capability', () => {
    expect(visibleGroups(pageOf('claude')).map((g) => g.id)).toEqual(['sandbox', 'proxy'])
  })

  it('drops a gated group when the engine lacks the capability', () => {
    const caps = { sandbox: false, proxy: false } as unknown as EngineCapabilities
    expect(visibleGroups(pageOf('claude'), caps)).toEqual([])
    const onlyProxy = { sandbox: false, proxy: true } as unknown as EngineCapabilities
    expect(visibleGroups(pageOf('claude'), onlyProxy).map((g) => g.id)).toEqual(['proxy'])
  })

  it('is unaffected on pages with no engine', () => {
    for (const page of PAGES.filter((p) => !p.engine)) {
      expect(visibleGroups(page)).toEqual(page.groups)
    }
  })
})

describe('searchSettings', () => {
  it('is empty for an empty query', () => {
    expect(searchSettings('   ')).toEqual([])
  })

  it('spans pages: "model" reaches Default models AND the auto-mode judge', () => {
    const hits = searchSettings('model')
    const groups = new Set(hits.map((h) => `${h.page.id}/${h.group.id}`))
    expect(groups.has('models/defaults')).toBe(true)
    expect(groups.has('sessions/judge')).toBe(true)
  })

  it('tags a byEngine hit with the engine list it came from', () => {
    const judgeHits = searchSettings('model').filter(
      (h) => h.page.id === 'sessions' && h.group.id === 'judge'
    )
    expect(judgeHits.map((h) => h.engine).sort()).toEqual(['opencode', 'pi'])
  })

  it('finds a setting by keyword alone, on a page the user never opened', () => {
    // "whitelist" appears in no label — only in the allowed-domains keywords.
    const hits = searchSettings('whitelist')
    expect(hits.some((h) => h.page.id === 'claude' && h.group.id === 'sandbox')).toBe(true)
    expect(hits.every((h) => !h.item.label.toLowerCase().includes('whitelist'))).toBe(true)
  })

  it('matches nothing for a nonsense query', () => {
    expect(searchSettings('zzzznotasetting')).toEqual([])
  })

  it('does NOT match a page description, which is prose', () => {
    // "How ClaudeUI looks." would otherwise make "look" (and "how", and "ui")
    // select every row on the Appearance page.
    const hits = searchSettings('looks')
    expect(hits.some((h) => h.page.id === 'appearance')).toBe(false)
  })

  it('still reaches a page through its GROUP label', () => {
    // The Claude page is findable by "sandbox" without matching its prose.
    const hits = searchSettings('sandbox')
    expect(hits.some((h) => h.page.id === 'claude' && h.group.id === 'sandbox')).toBe(true)
  })
})

describe('targetToLegacy (the mobile adapter)', () => {
  it('round-trips every legacy section through its new home', () => {
    for (const section of SECTIONS) {
      const target = SECTION_TARGET[section.id]
      const back = targetToLegacy(target)
      expect(back.section, `no legacy section for ${section.id}`).toBeDefined()
      // Several sections can share one group (three engines' Default models);
      // the adapter picks one, and it must be filed in the SAME group.
      expect(SECTION_TARGET[back.section!]).toEqual(target)
    }
  })

  it('maps the app deep links onto the tab their section used to live on', () => {
    expect(targetToLegacy({ page: 'claude', group: 'sandbox' })).toEqual({
      scope: 'claude',
      section: 'sandbox'
    })
    expect(targetToLegacy({ page: 'remote', group: 'server' })).toEqual({
      scope: 'common',
      section: 'remote'
    })
    expect(targetToLegacy({ page: 'models', group: 'providers' })).toEqual({
      scope: 'common',
      section: 'shared-providers'
    })
  })

  it('falls back to the page when the group owns no legacy section', () => {
    // Chat › Git actions holds one ITEM of the legacy `git` section, which is
    // filed under Appearance › Git panel — so the page-level fallback answers.
    const back = targetToLegacy({ page: 'chat', group: 'git-actions' })
    expect(back.scope).toBe('common')
    expect(SECTION_TARGET[back.section!].page).toBe('chat')
  })

  it('answers a page-only target', () => {
    expect(targetToLegacy({ page: 'opencode' })).toEqual({
      scope: 'opencode',
      section: 'opencode-session'
    })
  })
})
