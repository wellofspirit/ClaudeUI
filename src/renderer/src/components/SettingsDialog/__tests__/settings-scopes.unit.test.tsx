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
import {
  SECTIONS,
  SCOPES,
  SECTION_SCOPE_MAP,
  SECTION_CAPABILITY,
  CONFIG_POINTER_KEYS,
  CONFIG_HIDDEN_KEYS,
  scopeCapabilities,
  isSectionVisible
} from '../settings-sections'
import opencodeConfigSchema from '../../../../../shared/opencode-config-schema.1.18.23.json'
import {
  CLAUDE_ENGINE_CAPABILITIES,
  OPENCODE_ENGINE_CAPABILITIES,
  PI_ENGINE_CAPABILITIES,
  type EngineCapabilities
} from '../../../../../shared/model-capabilities'

describe('SCOPES structure', () => {
  it('has exactly 4 scopes', () => {
    expect(SCOPES).toHaveLength(4)
  })

  it('scope ids are common / claude / opencode / pi', () => {
    expect(SCOPES.map((s) => s.id)).toEqual(['common', 'claude', 'opencode', 'pi'])
  })

  it('scope labels are Common / Claude / opencode / pi', () => {
    expect(SCOPES.map((s) => s.label)).toEqual(['Common', 'Claude', 'opencode', 'pi'])
  })

  describe('common scope', () => {
    const common = SCOPES.find((s) => s.id === 'common')!

    it('exists', () => expect(common).toBeDefined())

    it('has one flat subgroup (no header)', () => {
      expect(common.subgroups).toHaveLength(1)
      expect(common.subgroups[0].label).toBeUndefined()
    })

    it('contains the 14 app sections in order', () => {
      const ids = common.subgroups.flatMap((sg) => sg.sections.map((s) => s.id))
      expect(ids).toEqual([
        'appearance',
        'chat',
        'session',
        'autonomy',
        'shared-providers',
        'tool-output',
        'diff',
        'git',
        'status-line',
        'usage',
        'logging',
        'voice',
        'remote',
        'mockup'
      ])
    })

    // ADR-050: the autonomy default is engine-neutral, so its picker lives in
    // the Common scope — parking it under Claude read as Claude-only.
    it('owns the autonomy section (not the Claude scope)', () => {
      const ids = common.subgroups.flatMap((sg) => sg.sections.map((s) => s.id))
      expect(ids).toContain('autonomy')
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
        'Engine',
        'Vendor · Anthropic',
        'Account'
      ])
    })

    it('Engine subgroup contains permissions, sandbox, proxy, claude-dispatch in order', () => {
      const engine = claude.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).toEqual([
        'permissions',
        'sandbox',
        'proxy',
        'claude-dispatch'
      ])
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

    it('has 4 subgroups: Engine, Configuration, Vendor, Agents', () => {
      expect(opencode.subgroups.map((sg) => sg.label)).toEqual([
        'Engine',
        'Configuration',
        'Vendor',
        'Agents'
      ])
    })

    it('Engine subgroup contains opencode-automode, opencode-models, opencode-dispatch in order', () => {
      const engine = opencode.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).toEqual([
        'opencode-automode',
        'opencode-models',
        'opencode-dispatch'
      ])
    })

    // The curated panes over opencode's own config file, with the generic
    // editor ("Raw config") last for everything they don't cover.
    it('Configuration subgroup contains the 7 curated panes then opencode-config, in order', () => {
      const configuration = opencode.subgroups.find((sg) => sg.label === 'Configuration')!
      expect(configuration.sections.map((s) => s.id)).toEqual([
        'opencode-session',
        'opencode-tool-output',
        'opencode-attachments',
        'opencode-workspace',
        'opencode-tools',
        'opencode-diagnostics',
        'opencode-managed',
        'opencode-config'
      ])
    })

    // A bad import would leave the element type `undefined` and only blow up
    // when the user opens the section; building the element catches it here.
    it('every Configuration section renders a defined component', () => {
      const configuration = opencode.subgroups.find((sg) => sg.label === 'Configuration')!
      for (const section of configuration.sections) {
        for (const item of section.items) {
          const el = item.render(
            {} as Parameters<typeof item.render>[0],
            () => {},
            {} as never,
            () => {},
            {} as never,
            () => {}
          )
          expect(el.type, `${section.id}/${item.key} renders an undefined component`).toBeTruthy()
        }
      }
    })

    it('opencode-config is labelled "Raw config" and no longer sits under Engine', () => {
      const engine = opencode.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).not.toContain('opencode-config')
      const raw = SECTIONS.find((s) => s.id === 'opencode-config')!
      expect(raw.label).toBe('Raw config')
      expect(raw.items[0].label).toBe('Raw config (opencode.json)')
    })

    it('Vendor subgroup contains only vendor-opencode', () => {
      // 'opencode-providers' ("Custom providers") was merged INTO vendor-opencode:
      // custom declarations now sit in the single Providers list, edited through the
      // provider configuration dialog rather than their own section.
      const vendor = opencode.subgroups.find((sg) => sg.label === 'Vendor')!
      expect(vendor.sections.map((s) => s.id)).toEqual(['vendor-opencode'])
    })

    it('Agents subgroup contains opencode-agents', () => {
      const agents = opencode.subgroups.find((sg) => sg.label === 'Agents')!
      expect(agents.sections.map((s) => s.id)).toEqual(['opencode-agents'])
    })
  })

  describe('pi scope', () => {
    const pi = SCOPES.find((s) => s.id === 'pi')!

    it('exists', () => expect(pi).toBeDefined())

    it('has 2 subgroups: Engine, Vendor', () => {
      expect(pi.subgroups.map((sg) => sg.label)).toEqual(['Engine', 'Vendor'])
    })

    it('Engine subgroup contains pi-automode then pi-models (no dispatch — pi is source-only)', () => {
      const engine = pi.subgroups.find((sg) => sg.label === 'Engine')!
      expect(engine.sections.map((s) => s.id)).toEqual(['pi-automode', 'pi-models'])
    })

    it('Vendor subgroup contains vendor-pi', () => {
      const vendor = pi.subgroups.find((sg) => sg.label === 'Vendor')!
      expect(vendor.sections.map((s) => s.id)).toEqual(['vendor-pi'])
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
      expect(SECTION_SCOPE_MAP.has(section.id), `SECTION_SCOPE_MAP missing "${section.id}"`).toBe(
        true
      )
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

  it('opencode-dispatch → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-dispatch')).toBe('opencode')
  })

  it('claude-dispatch → claude', () => {
    expect(SECTION_SCOPE_MAP.get('claude-dispatch')).toBe('claude')
  })

  it('opencode-providers is no longer a section (merged into vendor-opencode)', () => {
    expect(SECTION_SCOPE_MAP.has('opencode-providers')).toBe(false)
  })

  it('opencode-agents → opencode', () => {
    expect(SECTION_SCOPE_MAP.get('opencode-agents')).toBe('opencode')
  })

  it('every Configuration-subgroup section → opencode', () => {
    for (const id of [
      'opencode-session',
      'opencode-tool-output',
      'opencode-attachments',
      'opencode-workspace',
      'opencode-tools',
      'opencode-diagnostics',
      'opencode-managed',
      'opencode-config'
    ]) {
      expect(SECTION_SCOPE_MAP.get(id), `${id} should map to the opencode scope`).toBe('opencode')
    }
  })

  it('vendor-anthropic → claude', () => {
    expect(SECTION_SCOPE_MAP.get('vendor-anthropic')).toBe('claude')
  })

  it('pi-models → pi', () => {
    expect(SECTION_SCOPE_MAP.get('pi-models')).toBe('pi')
  })

  it('pi-automode → pi', () => {
    expect(SECTION_SCOPE_MAP.get('pi-automode')).toBe('pi')
  })

  it('vendor-pi → pi', () => {
    expect(SECTION_SCOPE_MAP.get('vendor-pi')).toBe('pi')
  })
})

/**
 * The raw editor partitions the vendored schema's top-level Config keys three
 * ways: HIDDEN (rendered nowhere), POINTER (read-only "managed in X" row), and
 * everything else (editable). The partition is derived, not hardcoded — but a
 * key misspelled in either set would silently fall back into the EDITABLE
 * bucket, giving a curated pane and the raw editor two writers for one key.
 */
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

  it('every pointer label names a real opencode-scope section', () => {
    const sectionLabels = new Set(
      SCOPES.find((s) => s.id === 'opencode')!.subgroups.flatMap((sg) =>
        sg.sections.map((s) => s.label)
      )
    )
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
    const mockVendorConfig = {
      endpoint: { enabled: true, baseUrl: 'https://test.com', authToken: '' },
      modelOverride: { enabled: false }
    }
    const mockUpdateVendor = (): void => {}
    // Should not throw — this is the smoke test
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

describe('Per-section capability gating (#12)', () => {
  it('scopeCapabilities maps scope → static engine caps (common = null)', () => {
    expect(scopeCapabilities('claude')).toBe(CLAUDE_ENGINE_CAPABILITIES)
    expect(scopeCapabilities('opencode')).toBe(OPENCODE_ENGINE_CAPABILITIES)
    expect(scopeCapabilities('pi')).toBe(PI_ENGINE_CAPABILITIES)
    expect(scopeCapabilities('common')).toBeNull()
  })

  it('pi declares no sandbox / proxy (M3 has no launch-param sections for it)', () => {
    expect(PI_ENGINE_CAPABILITIES.sandbox).toBe(false)
    expect(PI_ENGINE_CAPABILITIES.proxy).toBe(false)
  })

  it('Claude declares the sandbox + proxy launch-param capabilities', () => {
    expect(CLAUDE_ENGINE_CAPABILITIES.sandbox).toBe(true)
    expect(CLAUDE_ENGINE_CAPABILITIES.proxy).toBe(true)
  })

  it('opencode declares no sandbox / proxy (it uses its own provider config)', () => {
    expect(OPENCODE_ENGINE_CAPABILITIES.sandbox).toBe(false)
    expect(OPENCODE_ENGINE_CAPABILITIES.proxy).toBe(false)
  })

  it('SECTION_CAPABILITY gates the sandbox + proxy sections', () => {
    expect(SECTION_CAPABILITY.sandbox).toBe('sandbox')
    expect(SECTION_CAPABILITY.proxy).toBe('proxy')
  })

  it('ungated sections + the common scope (caps=null) are always visible', () => {
    expect(isSectionVisible('appearance', null)).toBe(true)
    expect(isSectionVisible('appearance', CLAUDE_ENGINE_CAPABILITIES)).toBe(true)
    expect(isSectionVisible('permissions', CLAUDE_ENGINE_CAPABILITIES)).toBe(true)
    // Even a gated section id is visible under the engine-agnostic 'common' scope.
    expect(isSectionVisible('sandbox', null)).toBe(true)
  })

  it('Claude shows sandbox + proxy (both caps true) — no user-visible change today', () => {
    expect(isSectionVisible('sandbox', CLAUDE_ENGINE_CAPABILITIES)).toBe(true)
    expect(isSectionVisible('proxy', CLAUDE_ENGINE_CAPABILITIES)).toBe(true)
  })

  it('GATING PROOF: a gated section hides when the engine lacks the capability', () => {
    // Structure-ready: a hypothetical no-sandbox/no-proxy engine hides those sections.
    const noLaunchParams: EngineCapabilities = {
      ...CLAUDE_ENGINE_CAPABILITIES,
      sandbox: false,
      proxy: false
    }
    expect(isSectionVisible('sandbox', noLaunchParams)).toBe(false)
    expect(isSectionVisible('proxy', noLaunchParams)).toBe(false)
    // Ungated sections still show on that engine.
    expect(isSectionVisible('permissions', noLaunchParams)).toBe(true)
  })
})
