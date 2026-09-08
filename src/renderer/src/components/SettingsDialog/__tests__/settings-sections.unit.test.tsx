/**
 * Layer 1: `settings-sections.tsx` — the ITEM SOURCE.
 *
 * ADR-065 phase 7 deleted the scope tree that used to live at the tail of that
 * file, and `settings-scopes.unit.test.tsx` with it. Three of that suite's
 * guard groups were never about scopes at all; they are about the item source,
 * so they live here now. Arrangement is `settings-pages.unit.test.tsx`'s
 * subject; what is guarded HERE is that the items themselves are sound.
 *
 *   1. The opencode raw-config key PARTITION. Every top-level `Config` key is
 *      either owned by a curated pane (a read-only pointer in the raw editor),
 *      hidden outright, or editable in the raw editor. A key misspelled in
 *      either set silently falls back into the EDITABLE bucket — giving a
 *      curated pane and the raw editor two writers for one key, with no
 *      symptom until they disagree.
 *   2. Every item RENDERS A DEFINED COMPONENT. A bad import leaves the element
 *      type `undefined` and only blows up when the user opens that page.
 *   3. The Anthropic vendor row, whose render is the one that reads the fifth
 *      and sixth arguments (`vendorConfig` / `updateVendorConfig`).
 */

import { describe, it, expect } from 'vitest'
import {
  SECTIONS,
  CONFIG_POINTER_KEYS,
  CONFIG_HIDDEN_KEYS,
  type SettingItem
} from '../settings-sections'
import opencodeConfigSchema from '../../../../../shared/opencode-config-schema.1.18.29.json'

/** The six positional arguments every item body takes (`ctx` is optional). */
function renderWithMocks(item: SettingItem): React.JSX.Element {
  return item.render(
    {} as Parameters<typeof item.render>[0],
    () => {},
    {} as never,
    () => {},
    {} as never,
    () => {}
  )
}

describe('opencode raw-config key partition', () => {
  const configProps = Object.keys(opencodeConfigSchema.$defs.Config.properties)

  it('every pointer key exists in the vendored schema (catches typos)', () => {
    for (const key of Object.keys(CONFIG_POINTER_KEYS)) {
      expect(configProps, `pointer key "${key}" is not a Config property`).toContain(key)
    }
  })

  it('every hidden key exists in the vendored schema (catches typos)', () => {
    for (const key of CONFIG_HIDDEN_KEYS) {
      expect(configProps, `hidden key "${key}" is not a Config property`).toContain(key)
    }
  })

  it('every pointer label names a real section', () => {
    // Each pointer is a DIRECTION ("Managed in Tools & integrations"), so its
    // label has to match the section the reader is being sent to. The scope
    // tree that used to scope this lookup to opencode's own sections is gone;
    // `SECTIONS` is the set that remains, and a renamed pane still fails here.
    const sectionLabels = new Set(SECTIONS.map((s) => s.label))
    // Pointers that name a place rather than a section stay as prose.
    const prose = new Set(['Providers', 'Custom providers', 'injected at spawn', 'Autonomy mode'])
    for (const [key, label] of Object.entries(CONFIG_POINTER_KEYS)) {
      if (prose.has(label)) continue
      expect(sectionLabels, `pointer "${key}" → "${label}" matches no section`).toContain(label)
    }
  })

  it('no key is both hidden and a pointer', () => {
    for (const key of Object.keys(CONFIG_POINTER_KEYS)) {
      expect(CONFIG_HIDDEN_KEYS.has(key), `"${key}" is both hidden and a pointer`).toBe(false)
    }
  })

  it('leaves exactly the keys no curated pane covers editable', () => {
    const editable = configProps.filter(
      (k) => !(k in CONFIG_POINTER_KEYS) && !CONFIG_HIDDEN_KEYS.has(k)
    )
    expect(editable.toSorted()).toEqual([
      'command',
      'enterprise',
      'mode',
      'reference',
      'references',
      'username'
    ])
  })
})

describe('every item renders a defined component', () => {
  // Was scoped to the two Configuration subgroups while the scope tree existed;
  // there is no reason it ever was. Building the element is enough — React does
  // not call the component, so this costs nothing and catches the import.
  it('across every section', () => {
    for (const section of SECTIONS) {
      for (const item of section.items) {
        const el = renderWithMocks(item)
        expect(el.type, `${section.id}/${item.key} renders an undefined component`).toBeTruthy()
      }
    }
  })

  it('covers every section (the loop above is not vacuously true)', () => {
    expect(SECTIONS.length).toBeGreaterThan(30)
    expect(SECTIONS.every((s) => s.items.length > 0)).toBe(true)
  })
})

describe('Anthropic vendor section', () => {
  it('vendor-anthropic section exists and has vendorAnthropicEndpoint item', () => {
    const sec = SECTIONS.find((s) => s.id === 'vendor-anthropic')
    expect(sec).toBeDefined()
    const item = sec?.items.find((i) => i.key === 'vendorAnthropicEndpoint')
    expect(item).toBeDefined()
    expect(item?.label).toBe('Endpoint & model override')
  })

  it('vendor-anthropic item render accepts vendorConfig + updateVendorConfig args', () => {
    const sec = SECTIONS.find((s) => s.id === 'vendor-anthropic')!
    const item = sec.items.find((i) => i.key === 'vendorAnthropicEndpoint')!
    // This is the render that actually reads args 5-6 — verify it is callable
    // with mock args without throwing.
    const mockSettings = {} as Parameters<typeof item.render>[0]
    const mockUpdate = (): void => {}
    const mockEngineConfig = {}
    const mockVendorConfig = {
      endpoint: { enabled: true, baseUrl: 'https://test.com', authToken: '' },
      modelOverride: { enabled: false }
    }
    const mockUpdateVendor = (): void => {}
    expect(() =>
      item.render(
        mockSettings,
        mockUpdate,
        mockEngineConfig as never,
        mockUpdate as never,
        mockVendorConfig as never,
        mockUpdateVendor
      )
    ).not.toThrow()
  })
})
