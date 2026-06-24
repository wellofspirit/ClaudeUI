/**
 * Unit tests for the settings tier tree structure.
 *
 * Tests that:
 * - NAV_GROUPS contains the four expected top-level groups: App, Engines, Vendors, Accounts
 * - The Engines group has a 'Claude' child
 * - The Vendors group has an 'Anthropic' child
 * - All sections in SECTIONS are covered by exactly one NAV_GROUP
 * - The permissions section contains the autonomy mode item
 * - The vendor-anthropic section exists in SECTIONS
 * - Search filtering works across all sections from all groups
 */

import { describe, it, expect } from 'vitest'
import { SECTIONS, NAV_GROUPS } from '../settings-sections'

describe('NAV_GROUPS tier tree structure', () => {
  it('has four top-level groups', () => {
    expect(NAV_GROUPS).toHaveLength(4)
  })

  it('has App as first group', () => {
    const app = NAV_GROUPS.find((g) => g.id === 'app')
    expect(app).toBeDefined()
    expect(app?.label).toBe('App')
  })

  it('has Engines as second group', () => {
    const engines = NAV_GROUPS.find((g) => g.id === 'engines')
    expect(engines).toBeDefined()
    expect(engines?.label).toBe('Engines')
  })

  it('has Vendors as third group', () => {
    const vendors = NAV_GROUPS.find((g) => g.id === 'vendors')
    expect(vendors).toBeDefined()
    expect(vendors?.label).toBe('Vendors')
  })

  it('has Accounts as fourth group', () => {
    const accounts = NAV_GROUPS.find((g) => g.id === 'accounts-group')
    expect(accounts).toBeDefined()
    expect(accounts?.label).toBe('Accounts')
  })

  describe('Engines group', () => {
    it('has a Claude child', () => {
      const engines = NAV_GROUPS.find((g) => g.id === 'engines')
      const claude = engines?.children?.find((c) => c.id === 'engine-claude')
      expect(claude).toBeDefined()
      expect(claude?.label).toBe('Claude')
    })

    it('Claude child has permissions and sandbox sections', () => {
      const engines = NAV_GROUPS.find((g) => g.id === 'engines')
      const claude = engines?.children?.find((c) => c.id === 'engine-claude')
      const sectionIds = claude?.sections.map((s) => s.id) ?? []
      expect(sectionIds).toContain('permissions')
      expect(sectionIds).toContain('sandbox')
      expect(sectionIds).toContain('proxy')
    })

    it('has an opencode child with the auto-mode section', () => {
      const engines = NAV_GROUPS.find((g) => g.id === 'engines')
      const opencode = engines?.children?.find((c) => c.id === 'engine-opencode')
      expect(opencode).toBeDefined()
      expect(opencode?.label).toBe('opencode')
      expect(opencode?.sections.map((s) => s.id)).toContain('opencode-automode')
    })
  })

  describe('Vendors group', () => {
    it('has an Anthropic child', () => {
      const vendors = NAV_GROUPS.find((g) => g.id === 'vendors')
      const anthropic = vendors?.children?.find((c) => c.id === 'vendor-anthropic-nav')
      expect(anthropic).toBeDefined()
      expect(anthropic?.label).toBe('Anthropic')
    })

    it('Anthropic child includes the vendor-anthropic section', () => {
      const vendors = NAV_GROUPS.find((g) => g.id === 'vendors')
      const anthropic = vendors?.children?.find((c) => c.id === 'vendor-anthropic-nav')
      const sectionIds = anthropic?.sections.map((s) => s.id) ?? []
      expect(sectionIds).toContain('vendor-anthropic')
    })
  })

  describe('App group', () => {
    it('contains appearance, chat, session, diff, git sections', () => {
      const app = NAV_GROUPS.find((g) => g.id === 'app')
      const sectionIds = app?.sections?.map((s) => s.id) ?? []
      expect(sectionIds).toContain('appearance')
      expect(sectionIds).toContain('chat')
      expect(sectionIds).toContain('session')
      expect(sectionIds).toContain('diff')
      expect(sectionIds).toContain('git')
    })

    it('does NOT contain sandbox or proxy (those are in Engines)', () => {
      const app = NAV_GROUPS.find((g) => g.id === 'app')
      const sectionIds = app?.sections?.map((s) => s.id) ?? []
      expect(sectionIds).not.toContain('sandbox')
      expect(sectionIds).not.toContain('proxy')
    })
  })

  it('all SECTIONS appear in exactly one NAV_GROUP', () => {
    const allNavSectionIds = new Set<string>()
    for (const group of NAV_GROUPS) {
      for (const s of group.sections ?? []) allNavSectionIds.add(s.id)
      for (const child of group.children ?? []) {
        for (const s of child.sections) allNavSectionIds.add(s.id)
      }
    }
    for (const section of SECTIONS) {
      expect(allNavSectionIds.has(section.id)).toBe(true)
    }
  })

  it('no section appears in more than one NAV_GROUP', () => {
    const sectionCounts = new Map<string, number>()
    for (const group of NAV_GROUPS) {
      for (const s of group.sections ?? []) {
        sectionCounts.set(s.id, (sectionCounts.get(s.id) ?? 0) + 1)
      }
      for (const child of group.children ?? []) {
        for (const s of child.sections) {
          sectionCounts.set(s.id, (sectionCounts.get(s.id) ?? 0) + 1)
        }
      }
    }
    for (const [, count] of sectionCounts) {
      expect(count).toBe(1)
    }
  })
})

describe('SECTIONS content', () => {
  it('permissions section has autonomy mode item', () => {
    const permissions = SECTIONS.find((s) => s.id === 'permissions')
    expect(permissions).toBeDefined()
    const autonomyItem = permissions?.items.find((item) => item.key === 'autonomyMode')
    expect(autonomyItem).toBeDefined()
    expect(autonomyItem?.keywords).toContain('autonomy')
  })

  it('permissions section still has global permissions item', () => {
    const permissions = SECTIONS.find((s) => s.id === 'permissions')
    const globalItem = permissions?.items.find((item) => item.key === 'globalPermissions')
    expect(globalItem).toBeDefined()
  })

  it('vendor-anthropic section exists and has vendorAnthropicDisplay item', () => {
    const vendorSection = SECTIONS.find((s) => s.id === 'vendor-anthropic')
    expect(vendorSection).toBeDefined()
    expect(vendorSection?.label).toBe('Anthropic')
    const displayItem = vendorSection?.items.find((item) => item.key === 'vendorAnthropicDisplay')
    expect(displayItem).toBeDefined()
  })

  it('sandbox section has multiple items', () => {
    const sandbox = SECTIONS.find((s) => s.id === 'sandbox')
    expect(sandbox).toBeDefined()
    expect((sandbox?.items.length ?? 0)).toBeGreaterThan(1)
  })

  it('proxy section has multiple items', () => {
    const proxy = SECTIONS.find((s) => s.id === 'proxy')
    expect(proxy).toBeDefined()
    expect((proxy?.items.length ?? 0)).toBeGreaterThan(1)
  })
})

describe('Search filtering across all sections', () => {
  it('all sections have at least one item with a label', () => {
    for (const section of SECTIONS) {
      expect(section.items.length).toBeGreaterThan(0)
      for (const item of section.items) {
        expect(typeof item.label).toBe('string')
      }
    }
  })

  it('simulated search "sandbox" finds the sandbox section', () => {
    const q = 'sandbox'
    const filtered = SECTIONS.filter((section) =>
      section.items.some(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q)) ||
          section.label.toLowerCase().includes(q)
      )
    )
    expect(filtered.some((s) => s.id === 'sandbox')).toBe(true)
  })

  it('simulated search "autonomy" finds the permissions section', () => {
    const q = 'autonomy'
    const filtered = SECTIONS.filter((section) =>
      section.items.some(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q)) ||
          section.label.toLowerCase().includes(q)
      )
    )
    expect(filtered.some((s) => s.id === 'permissions')).toBe(true)
  })

  it('simulated search "anthropic" finds the vendor-anthropic section', () => {
    const q = 'anthropic'
    const filtered = SECTIONS.filter((section) =>
      section.items.some(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q)) ||
          section.label.toLowerCase().includes(q)
      )
    )
    expect(filtered.some((s) => s.id === 'vendor-anthropic')).toBe(true)
  })
})
