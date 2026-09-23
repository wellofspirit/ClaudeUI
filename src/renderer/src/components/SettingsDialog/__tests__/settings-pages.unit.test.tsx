/**
 * Layer 1: the settings PAGE model (ADR-065).
 *
 * The load-bearing test here is the INVENTORY GUARD. The redesign re-homes 43
 * sections' worth of settings into 12 pages by hand; the failure mode is not a
 * crash but a setting that quietly stops having a home — unreachable in the UI,
 * still written in the config file. So the guard asserts an exact bijection:
 * every item key reachable from `PAGES` is either a key of some `SECTIONS`
 * entry or one of the three rows this model defines itself, each appearing
 * exactly once (a `byEngine` group counts one per engine list).
 */
import { describe, it, expect } from 'vitest'
import { SECTIONS } from '../settings-sections'
import {
  MAX_RESULT_BUCKETS,
  PAGES,
  PAGE_LOCAL_ITEMS,
  RAIL_GROUPS,
  SECTION_TARGET,
  appliesOnOf,
  bucketSearchHits,
  enginesOf,
  noteOf,
  pageOf,
  searchSettings,
  storageOf,
  visibleGroups,
  type SettingsGroup
} from '../settings-pages'
import type { EngineCapabilities } from '../../../../../shared/model-capabilities'

/**
 * One group of the dispatch page BY ID. The page grew an app-level Concurrency
 * card in front of the two engine cards (ADR-033, 2026-09-18), and every
 * assertion below is about a named card, not about a position.
 */
function dispatchGroup(id: string): SettingsGroup {
  const group = pageOf('dispatch').groups.find((g) => g.id === id)
  if (!group) throw new Error(`dispatch page has no group "${id}"`)
  return group
}

/** Every item a group can render, across every engine list it declares. */
function allItemsOf(group: SettingsGroup): Array<{ key: string; engine?: string }> {
  if (group.items) return group.items.map((i) => ({ key: i.key }))
  return enginesOf(group).flatMap((engine) =>
    (group.byEngine?.[engine] ?? []).map((i) => ({ key: i.key, engine }))
  )
}

describe('PAGES structure', () => {
  it('has the 13 documented pages, in order', () => {
    expect(PAGES.map((p) => p.id)).toEqual([
      'appearance',
      'chat',
      'sessions',
      'advanced',
      'about',
      'models',
      'dispatch',
      'mockups',
      'remote',
      'claude',
      'opencode',
      'pi',
      'codex'
    ])
  })

  it('has 3 rail groups and every page belongs to one', () => {
    expect(RAIL_GROUPS.map((g) => g.id)).toEqual(['app', 'features', 'engines'])
    const ids = new Set(RAIL_GROUPS.map((g) => g.id))
    for (const page of PAGES) expect(ids.has(page.rail)).toBe(true)
  })

  it('rail membership matches ADR-065 (App / Features / Engines)', () => {
    const byRail = (rail: string): string[] => PAGES.filter((p) => p.rail === rail).map((p) => p.id)
    expect(byRail('app')).toEqual(['appearance', 'chat', 'sessions', 'advanced', 'about'])
    expect(byRail('features')).toEqual(['models', 'dispatch', 'mockups', 'remote'])
    expect(byRail('engines')).toEqual(['claude', 'opencode', 'pi', 'codex'])
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
      appearance: ['theme', 'layout', 'agents', 'diff', 'status-line', 'git-panel'],
      chat: ['tool-output', 'thinking', 'voice', 'git-actions'],
      sessions: ['autonomy', 'permissions', 'judge', 'trust', 'retention'],
      advanced: ['logging', 'usage'],
      about: ['about'],
      models: [
        // ADR-074 §7: sign-in subscriptions first, then API providers — ONE
        // providers group since 6c, now without the subscriptions — then the
        // defaults. 'accounts' folded into the Subscriptions cards; 'anthropic'
        // moved to Claude › Endpoint / Model mapping (ADR-074 §9).
        'subscriptions',
        'providers',
        'defaults'
      ],
      dispatch: ['concurrency', 'into', 'limits'],
      mockups: ['network'],
      // 'usage-hub' last (ADR-072 §7): the one group here that pushes OUT.
      remote: ['follow', 'server', 'access', 'security', 'links', 'usage-hub'],
      // The Anthropic endpoint FIRST: it only ever reaches cli.js (ADR-074 §9).
      claude: ['endpoint', 'model-mapping', 'sandbox', 'proxy'],
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
      pi: ['session', 'retry', 'tools', 'attachments', 'workspace', 'resources', 'network', 'raw'],
      // Slice 5a (ADR-068 §6): the Codex page grew the curated groups over
      // `config.toml`, in the one-home table's order.
      codex: [
        'account',
        'model',
        'context',
        'instructions',
        'sandbox',
        'shell',
        'tools',
        'agents',
        'mcp',
        'history',
        'managed',
        'raw'
      ]
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
    // Codex writes ONE file, and the binary does not hot-reload the
    // session-static keys on it, so every group that writes says "next session"
    // with the same tag. Account, Managed and Raw config write nothing.
    for (const g of pageOf('codex').groups) {
      if (['account', 'managed', 'raw'].includes(g.id)) {
        expect(g.appliesOn, `codex/${g.id}`).toBeUndefined()
        continue
      }
      expect(g.appliesOn, `codex/${g.id}`).toBe('next-session')
      expect(g.note, `codex/${g.id}`).toBeTruthy()
    }
    for (const g of pageOf('codex').groups) {
      expect(storageOf(g, 'codex'), `codex/${g.id}`).toBe(
        g.id === 'account' ? undefined : 'config.toml'
      )
    }
    // ClaudeUI's own settings apply at once — no badge, no note.
    for (const g of pageOf('appearance').groups) expect(g.appliesOn).toBeUndefined()
  })

  it('the Providers group is ONE list with a LIVE header action', () => {
    // ADR-065 § "Providers: one list": the card fronts three stores now, so the
    // 'Shared' badge would be a lie about what it holds.
    const providers = pageOf('models').groups.find((g) => g.id === 'providers')!
    expect(providers.badge).toBeUndefined()
    expect(providers.action).toMatchObject({
      label: '+ Add provider',
      testid: 'ProviderList.add',
      event: 'settings:add-provider'
    })
    // 6c wired the Add sheet: the button is live, and the "why it does nothing"
    // tooltip is gone with the reason for it.
    expect(providers.action?.disabled).toBeFalsy()
    expect(providers.action?.title).toBeUndefined()
  })

  it('no provider group survives outside the one list', () => {
    // The 6b bridge (`providers-shared-legacy`) and the two engine-native
    // groups are DELETED, not hidden: a second provider surface is exactly what
    // ADR-065 § "Providers: one list" exists to remove.
    const ids = PAGES.flatMap((page) => page.groups.map((group) => group.id))
    for (const gone of ['providers-opencode', 'providers-pi', 'providers-shared-legacy']) {
      expect(ids).not.toContain(gone)
    }
    expect(SECTIONS.map((section) => section.id)).not.toContain('vendor-opencode')
    expect(SECTIONS.map((section) => section.id)).not.toContain('vendor-pi')
    expect(
      SECTIONS.find((section) => section.id === 'shared-providers')!.items.map((item) => item.key)
    ).toEqual(['sharedProviders'])
  })

  it('exactly one group declares a header action, and it names an event, not a callback', () => {
    // A group definition is a static module-level object, so an action can only
    // carry a NAME the pane it renders listens for.
    const withAction = PAGES.flatMap((p) => p.groups).filter((g) => g.action)
    expect(withAction.map((g) => g.id)).toEqual(['providers'])
    for (const group of withAction) {
      expect(typeof group.action!.event).toBe('string')
      expect(group.action!.event.length).toBeGreaterThan(0)
    }
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

  it('byEngine groups list their engines in claude → opencode → pi → codex order', () => {
    expect(enginesOf(pageOf('sessions').groups[2])).toEqual(['opencode', 'pi', 'codex'])
    expect(enginesOf(pageOf('models').groups.find((g) => g.id === 'defaults')!)).toEqual([
      'claude',
      'opencode',
      'pi',
      'codex'
    ])
    // pi joined as a dispatch TARGET: core has accepted it since M4c, the UI
    // pane is what was missing (ADR-065 § Cross-engine dispatch into pi).
    // Codex joined on the same terms with ADR-068 §6 (slice H accepted it).
    expect(enginesOf(dispatchGroup('into'))).toEqual(['claude', 'opencode', 'pi', 'codex'])
    expect(enginesOf(dispatchGroup('limits'))).toEqual(['claude', 'opencode', 'pi', 'codex'])
  })

  it('the Limits card follows the Dispatch-into segment instead of drawing its own', () => {
    const into = dispatchGroup('into')
    const limits = dispatchGroup('limits')
    expect(into.engineFrom).toBeUndefined()
    // Two segments on one page would let the two cards describe DIFFERENT
    // targets while sitting one above the other.
    expect(limits.engineFrom).toBe('into')
    expect(PAGES.flatMap((p) => p.groups).filter((g) => g.engineFrom).length).toBe(1)
  })

  it('a per-engine note and applies-on resolve against the selected engine', () => {
    const defaults = pageOf('models').groups.find((g) => g.id === 'defaults')!
    // opencode reads its config when the per-cwd SERVER restarts…
    expect(appliesOnOf(defaults, 'opencode')).toBe('next-server-start')
    expect(noteOf(defaults, 'opencode')).toContain('opencode server restarts')
    // …Claude and pi at the next session. Every engine gets a SENTENCE, not
    // just opencode: the badge only renders alongside a note, so a note-less
    // `appliesOn` would be computed and then dropped.
    expect(appliesOnOf(defaults, 'claude')).toBe('next-session')
    expect(appliesOnOf(defaults, 'pi')).toBe('next-session')
    expect(noteOf(defaults, 'claude')).toBe('Applies to new Claude sessions.')
    expect(noteOf(defaults, 'pi')).toBe('Applies to new pi sessions.')

    // The dispatch Limits note names the target and its callers.
    const limits = dispatchGroup('limits')
    // Codex hosts `dispatch_agent` too (ADR-033 slice H), so it is named as a
    // possible CALLER of every other target, not only as a target of its own.
    expect(noteOf(limits, 'pi')).toContain('into pi from a Claude, opencode or Codex session')
    expect(noteOf(limits, 'claude')).toContain('into Claude from an opencode, pi or Codex session')
    expect(noteOf(limits, 'codex')).toContain('into Codex from a Claude, opencode or pi session')
  })

  it('the Limits card carries no applies-later badge and no storage tag', () => {
    const limits = dispatchGroup('limits')
    // The dispatcher re-reads `loadEngineConfig(engine).dispatch` on EVERY
    // dispatch call (cross-engine-dispatcher.ts's three cost-cap gates), so a
    // changed cap or timeout binds the very next one — "Next session" would be
    // a false promise.
    expect(limits.appliesOn).toBeUndefined()
    expect(appliesOnOf(limits, 'pi')).toBeUndefined()
    // And a follower group's header is bare: the file tag would just repeat the
    // one on the card directly above it (`board2-Dispatch.png`).
    expect(limits.storage).toBeUndefined()
    expect(storageOf(limits, 'pi')).toBeUndefined()
    expect(storageOf(dispatchGroup('into'), 'pi')).toBe('engines/pi.json')
  })

  it('a STATIC note and applies-on are returned unchanged, whatever the engine', () => {
    const judge = pageOf('sessions').groups.find((g) => g.id === 'judge')!
    expect(noteOf(judge, 'opencode')).toBe(noteOf(judge, 'pi'))
    expect(appliesOnOf(judge, 'pi')).toBe('next-session')
    // A group with neither says nothing.
    expect(noteOf(pageOf('appearance').groups[0], undefined)).toBeUndefined()
    expect(appliesOnOf(pageOf('appearance').groups[0], undefined)).toBeUndefined()
  })

  it('a per-engine storage tag resolves against the selected engine', () => {
    const judge = pageOf('sessions').groups[2]
    expect(storageOf(judge, 'opencode')).toBe('engines/opencode.json')
    expect(storageOf(judge, 'pi')).toBe('engines/pi.json')
    // A fixed tag ignores the engine.
    expect(
      storageOf(
        pageOf('claude').groups.find((g) => g.id === 'endpoint')!,
        'claude'
      )
    ).toBe('vendors/anthropic.json')
    // No tag = the group writes ClaudeUI's own settings.json.
    expect(storageOf(pageOf('appearance').groups[0], undefined)).toBeUndefined()

    // Default models writes a different file per engine — and NONE for Claude,
    // whose effort defaults are ClaudeUI's own settings.
    const defaults = pageOf('models').groups.find((g) => g.id === 'defaults')!
    expect(storageOf(defaults, 'opencode')).toBe('opencode.jsonc')
    expect(storageOf(defaults, 'pi')).toBe('settings.json')
    expect(storageOf(defaults, 'claude')).toBeUndefined()
  })
})

describe('Codex on the topic pages (ADR-068 §6, Slice 5b)', () => {
  const defaults = (): SettingsGroup => pageOf('models').groups.find((g) => g.id === 'defaults')!
  const judge = (): SettingsGroup => pageOf('sessions').groups.find((g) => g.id === 'judge')!

  it('Default models gains a codex segment over engines/codex.json', () => {
    expect(enginesOf(defaults())).toEqual(['claude', 'opencode', 'pi', 'codex'])
    expect(storageOf(defaults(), 'codex')).toBe('engines/codex.json')
    expect(appliesOnOf(defaults(), 'codex')).toBe('next-session')
    expect(noteOf(defaults(), 'codex')).toBe('Applies to new Codex sessions.')
  })

  it('Dispatch into / Limits gain a codex segment and name its real callers', () => {
    const into = dispatchGroup('into')
    const limits = dispatchGroup('limits')
    expect(enginesOf(into)).toEqual(['claude', 'opencode', 'pi', 'codex'])
    expect(enginesOf(limits)).toEqual(['claude', 'opencode', 'pi', 'codex'])
    expect(storageOf(into, 'codex')).toBe('engines/codex.json')
    expect(noteOf(limits, 'codex')).toContain('a Claude, opencode or pi session')
  })

  it('the Auto-mode judge gains a codex segment over config.toml', () => {
    expect(enginesOf(judge())).toEqual(['opencode', 'pi', 'codex'])
    // The Codex rows write `auto_review.policy` in Codex's own file, not
    // `engines/codex.json#autoMode` — the reviewer there is NATIVE (ADR-067).
    expect(storageOf(judge(), 'codex')).toBe('config.toml')
    expect(storageOf(judge(), 'pi')).toBe('engines/pi.json')
    expect(noteOf(judge(), 'codex')).toContain('Read once per thread')
  })

  it('the two stale Codex strings are gone', () => {
    // "Codex uses its native configured model." — written before Codex had a
    // configured ClaudeUI default at all.
    for (const engine of enginesOf(defaults())) {
      expect(noteOf(defaults(), engine)).not.toBe('Codex uses its native configured model.')
    }
    // DISPATCH_CALLERS.codex = 'unsupported' — the dispatcher has accepted
    // Codex as a target since ADR-033 slice H.
    const limits = dispatchGroup('limits')
    for (const engine of enginesOf(limits)) {
      expect(noteOf(limits, engine)).not.toContain('unsupported')
    }
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
    expect(local).toEqual([
      'sandboxCrossLink',
      'otherEnginePermissions',
      'versions',
      'codexNativeAccount',
      'usageHub'
    ])

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

  it('gives the new pi dispatch pane a home on the dispatch page', () => {
    expect(SECTION_TARGET['pi-dispatch']).toEqual({ page: 'dispatch', group: 'into' })
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
    expect(visibleGroups(pageOf('claude')).map((g) => g.id)).toEqual([
      'endpoint',
      'model-mapping',
      'sandbox',
      'proxy'
    ])
  })

  it('drops a gated group when the engine lacks the capability', () => {
    // The endpoint groups are ungated: every Claude build reads the env vars.
    const caps = { sandbox: false, proxy: false } as unknown as EngineCapabilities
    expect(visibleGroups(pageOf('claude'), caps).map((g) => g.id)).toEqual([
      'endpoint',
      'model-mapping'
    ])
    const onlyProxy = { sandbox: false, proxy: true } as unknown as EngineCapabilities
    expect(visibleGroups(pageOf('claude'), onlyProxy).map((g) => g.id)).toEqual([
      'endpoint',
      'model-mapping',
      'proxy'
    ])
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

  it('lands the old Anthropic endpoint searches on the Claude page (ADR-074 §9)', () => {
    const at = (q: string): Set<string> =>
      new Set(searchSettings(q).map((h) => `${h.page.id}/${h.group.id}`))
    expect(at('gateway').has('claude/endpoint')).toBe(true)
    expect(at('model override').has('claude/model-mapping')).toBe(true)
    expect(at('haiku').has('claude/model-mapping')).toBe(true)
    for (const q of ['gateway', 'model override', 'anthropic endpoint']) {
      expect(at(q).has('models/anthropic'), q).toBe(false)
    }
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

describe('bucketSearchHits', () => {
  /**
   * The reducer BOTH presentations render results with (ADR-065 phase 7 folded
   * the desktop's and the phone's copies together). What matters is that the
   * two can never bucket or cap the same query differently, so the rules live
   * here rather than in either view.
   */

  it('groups a query into page › group cards, in hit order', () => {
    const { buckets } = bucketSearchHits('sandbox')
    const claude = buckets.find((b) => b.page.id === 'claude' && b.group.id === 'sandbox')
    expect(claude).toBeDefined()
    // Every hit of one card lands in ONE bucket, and the bucket's rows are the
    // very items the group would render.
    const hits = searchSettings('sandbox').filter(
      (h) => h.page.id === 'claude' && h.group.id === 'sandbox'
    )
    expect(claude!.items).toEqual(hits.map((h) => h.item))
  })

  it('makes the engine part of a byEngine bucket id (ADR-027)', () => {
    const { buckets } = bucketSearchHits('judge model')
    const judge = buckets.filter((b) => b.group.id === 'judge')
    // Two engines, two buckets, two DISTINCT data-ids — one id rendered twice
    // is exactly what the discriminator exists to prevent.
    expect(judge.map((b) => b.id).sort()).toEqual(['sessions/judge/opencode', 'sessions/judge/pi'])
    expect(judge.map((b) => b.engine).sort()).toEqual(['opencode', 'pi'])
  })

  it('caps the buckets it returns but reports the true total', () => {
    // A one-character query matches far more cards than either view may mount:
    // each bucket renders LIVE rows and several panes fetch on mount.
    const wide = bucketSearchHits('e')
    expect(wide.total).toBeGreaterThan(MAX_RESULT_BUCKETS)
    expect(wide.buckets).toHaveLength(MAX_RESULT_BUCKETS)
    // The "N more groups match" line is total − shown, so the total must count
    // what was held back rather than what was returned.
    expect(wide.total).toBe(bucketSearchHits('e', Number.MAX_SAFE_INTEGER).buckets.length)
  })

  it('takes the cap from its caller', () => {
    expect(bucketSearchHits('e', 2).buckets).toHaveLength(2)
    expect(bucketSearchHits('e', 2).total).toBe(bucketSearchHits('e').total)
  })

  it('is empty for a query that matches nothing', () => {
    expect(bucketSearchHits('zzzznotasetting')).toEqual({ buckets: [], total: 0 })
  })
})
