/**
 * Unit tests for the SCOPES structure (settings IA refactor — Option A).
 *
 * Guards:
 * - SCOPES has exactly 3 scopes (common / claude / opencode)
 * - Every section in SECTIONS is assigned to exactly one scope (no orphans, no duplicates)
 * - Scope contents are correct and intentionally ordered
 * - SECTION_SCOPE_MAP is consistent with SCOPES
 */

import { describe, it, expect } from 'vitest'
import { SECTIONS, SCOPES, SECTION_SCOPE_MAP } from '../settings-sections'

describe('SCOPES structure', () => {
  it('has exactly 3 scopes', () => {
    expect(SCOPES).toHaveLength(3)
  })

  it('scope ids are common / claude / opencode', () => {
    expect(SCOPES.map((s) => s.id)).toEqual(['common', 'claude', 'opencode'])
  })

  it('scope labels are Common / Claude / opencode', () => {
    expect(SCOPES.map((s) => s.label)).toEqual(['Common', 'Claude', 'opencode'])
  })

  describe('common scope', () => {
    const common = SCOPES.find((s) => s.id === 'common')!

    it('exists', () => expect(common).toBeDefined())

    it('has one flat subgroup (no header)', () => {
      expect(common.subgroups).toHaveLength(1)
      expect(common.subgroups[0].label).toBeUndefined()
    })

    it('contains the 12 app sections in order', () => {
      const ids = common.subgroups.flatMap((sg) => sg.sections.map((s) => s.id))
      expect(ids).toEqual([
        'appearance', 'chat', 'session', 'tool-output', 'diff', 'git',
        'status-line', 'usage', 'logging', 'voice', 'remote', 'mockup'
      ])
    })

    it('does NOT contain sandbox or proxy', () => {
      const ids = common.subgroups.flatMap((sg) => sg.sections.map((s) => s.id))
      expect(ids).not.toContain('sandbox')
      expect(ids).not.toContain('proxy')
    })
  })

  describe('claude scope', () => {
    const claude = SCOPES.find((s) => s.id === 'claude')!

    it('exists', () => expect(claude).toBeDefined())

    it('has 3 subgroups: Engine, Vendor · Anthropic, Account', () => {
      expect(claude.subgroups.map((sg) => sg.label)).toEqual([
        'Engine', 'Vendor · Anthropic', 'Account'
      ])
    })

    it('Engine subgroup contains permissions, sandbox, proxy in order', () => {
      const engine = claude.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).toEqual(['permissions', 'sandbox', 'proxy'])
    })

    it('Vendor subgroup contains vendor-anthropic, effortDefaults in order', () => {
      const vendor = claude.subgroups.find((sg) => sg.label === 'Vendor · Anthropic')!
      expect(vendor.sections.map((s) => s.id)).toEqual(['vendor-anthropic', 'effortDefaults'])
    })

    it('Account subgroup contains accounts', () => {
      const account = claude.subgroups.find((sg) => sg.label === 'Account')!
      expect(account.sections.map((s) => s.id)).toEqual(['accounts'])
    })
  })

  describe('opencode scope', () => {
    const opencode = SCOPES.find((s) => s.id === 'opencode')!

    it('exists', () => expect(opencode).toBeDefined())

    it('has 3 subgroups: Engine, Vendor, Agents', () => {
      expect(opencode.subgroups.map((sg) => sg.label)).toEqual(['Engine', 'Vendor', 'Agents'])
    })

    it('Engine subgroup contains opencode-automode, opencode-models in order', () => {
      const engine = opencode.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).toEqual(['opencode-automode', 'opencode-models'])
    })

    it('Vendor subgroup contains vendor-opencode, opencode-providers in order', () => {
      const vendor = opencode.subgroups.find((sg) => sg.label === 'Vendor')!
      expect(vendor.sections.map((s) => s.id)).toEqual(['vendor-opencode', 'opencode-providers'])
    })

    it('Agents subgroup contains opencode-agents', () => {
      const agents = opencode.subgroups.find((sg) => sg.label === 'Agents')!
      expect(agents.sections.map((s) => s.id)).toEqual(['opencode-agents'])
    })
  })

  it('every SECTIONS entry appears in exactly one scope', () => {
    const sectionCounts = new Map<string, number>()
    for (const scope of SCOPES) {
      for (const sg of scope.subgroups) {
        for (const sec of sg.sections) {
          sectionCounts.set(sec.id, (sectionCounts.get(sec.id) ?? 0) + 1)
        }
      }
    }

    // No orphans
    for (const section of SECTIONS) {
      expect(
        sectionCounts.has(section.id),
        `Section "${section.id}" is not assigned to any scope`
      ).toBe(true)
    }

    // No duplicates
    for (const [id, count] of sectionCounts) {
      expect(count, `Section "${id}" appears in ${count} scopes`).toBe(1)
    }
  })
})

describe('SECTION_SCOPE_MAP', () => {
  it('maps every SECTIONS entry to a scope', () => {
    for (const section of SECTIONS) {
      expect(
        SECTION_SCOPE_MAP.has(section.id),
        `SECTION_SCOPE_MAP missing "${section.id}"`
      ).toBe(true)
    }
  })

  it('permissions → claude', () => {
    expect(SECTION_SCOPE_MAP.get('permissions')).toBe('claude')
  })

  it('appearance → common', () => {
    expect(SECTION_SCOPE_MAP.get('appearance')).toBe('common')
  })

  it('opencode-automode → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-automode')).toBe('opencode')
  })

  it('opencode-models → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-models')).toBe('opencode')
  })

  it('opencode-providers → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-providers')).toBe('opencode')
  })

  it('opencode-agents → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-agents')).toBe('opencode')
  })

  it('vendor-anthropic → claude', () => {
    expect(SECTION_SCOPE_MAP.get('vendor-anthropic')).toBe('claude')
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
    // The render fn must use args 5-6 (vendorConfig, updateVendorConfig) — verify it's callable
    // with mock args without throwing
    const mockSettings = {} as Parameters<typeof item.render>[0]
    const mockUpdate = (): void => {}
    const mockEngineConfig = {}
    const mockVendorConfig = { endpoint: { enabled: true, baseUrl: 'https://test.com', authToken: '' }, modelOverride: { enabled: false } }
    const mockUpdateVendor = (): void => {}
    // Should not throw — this is the smoke test
    expect(() =>
      item.render(mockSettings, mockUpdate, mockEngineConfig as never, mockUpdate as never, mockVendorConfig as never, mockUpdateVendor)
    ).not.toThrow()
  })
})
