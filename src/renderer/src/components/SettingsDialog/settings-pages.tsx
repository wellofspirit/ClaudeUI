/**
 * The settings PAGE model (ADR-065).
 *
 * The dialog used to be organised by which FILE a setting is written to —
 * "Common" was ClaudeUI's settings.json, "Engine" was `engines/*.json`,
 * "Configuration" was the engine's own config, "Vendor" was `vendors/*.json`.
 * That put one concept in several places (the auto-mode judge under both
 * opencode and pi, dispatch twice, model defaults in four sections) and left
 * ~20 of the 43 sections with three rows or fewer.
 *
 * Here, settings are organised by TASK: 11 pages in 3 rail groups, each page an
 * ordered list of GROUPS, each group a card of rows. Storage location becomes a
 * tag on the group header — information, never navigation.
 *
 * The item bodies are NOT re-implemented: every group points at the very same
 * `SettingItem` objects `SECTIONS` already exports, so a setting has exactly one
 * render path and one home. `itemsOf()` throws at module load on a typo'd key,
 * so a dropped setting fails the test run rather than vanishing from the UI.
 *
 * Import direction is one-way: this file imports FROM `settings-sections.tsx`
 * and never the reverse (that file imports the pane components, so the reverse
 * edge would be a cycle). Anything both sides need lives in `settings-target.ts`.
 */
import type { EngineId } from '../../../../shared/types'
import type { EngineCapabilities } from '../../../../shared/model-capabilities'
import { engineMeta } from '../../../../shared/engine-meta'
import {
  SECTIONS,
  SECTION_SCOPE_MAP,
  type Section,
  type SettingItem,
  type SettingsScope
} from './settings-sections'
import { SettingRow, ActionRow } from './settings-controls'
import type { SettingsPageId, SettingsTarget } from './settings-target'

export type { SettingsPageId, SettingsTarget } from './settings-target'

export type RailGroupId = 'app' | 'features' | 'engines'

export interface SettingsGroup {
  /** Unique within its page; used in deep links and as the rail sub-entry id. */
  id: string
  label: string
  /**
   * Header tag naming the file this group writes. Omit for ClaudeUI's own
   * settings.json. A function when the file depends on the selected engine.
   */
  storage?: string | ((engine: EngineId) => string)
  /** Header badge text (e.g. 'All engines'). */
  badge?: string
  /** Capability gate, evaluated against the page's engine (sandbox/proxy). */
  requires?: 'sandbox' | 'proxy'
  /** Exactly one of `items` / `byEngine`. byEngine draws an engine segment. */
  items?: SettingItem[]
  byEngine?: Partial<Record<EngineId, SettingItem[]>>
}

export interface SettingsPage {
  id: SettingsPageId
  label: string
  rail: RailGroupId
  /** 14px, stroke 1.8 — the rail's icon size (the boards). */
  icon: React.JSX.Element
  /** One line under the title. */
  description: string
  /** Engines pages only: the engine the page is about (drives the gating). */
  engine?: EngineId
  groups: SettingsGroup[]
}

export const RAIL_GROUPS: ReadonlyArray<{ id: RailGroupId; label: string }> = [
  { id: 'app', label: 'App' },
  { id: 'features', label: 'Features' },
  { id: 'engines', label: 'Engines' }
]

// ── Item lookup ──────────────────────────────────────────────────────

function sectionOf(sectionId: string): Section {
  const section = SECTIONS.find((s) => s.id === sectionId)
  if (!section) throw new Error(`settings-pages: no section "${sectionId}"`)
  return section
}

/**
 * The items of a section — all of them, or the named keys in the given order.
 * Throws at MODULE LOAD on an unknown id/key, so a typo fails every test that
 * imports this file instead of silently dropping a setting from the UI.
 */
function itemsOf(sectionId: string, keys?: string[]): SettingItem[] {
  const section = sectionOf(sectionId)
  if (!keys) return section.items
  return keys.map((key) => {
    const item = section.items.find((i) => i.key === key)
    if (!item) throw new Error(`settings-pages: section "${sectionId}" has no item "${key}"`)
    return item
  })
}

// ── Rows defined here, not in a legacy section ───────────────────────

/**
 * The Sessions page cross-links to the Claude sandbox rather than repeating its
 * master toggle: a setting has exactly one home (ADR-065).
 */
const SANDBOX_CROSS_LINK: SettingItem = {
  key: 'sandboxCrossLink',
  label: 'Command sandbox',
  keywords: 'sandbox isolation network filesystem claude seatbelt bubblewrap',
  render: (_s, _u, _e, _ue, _v, _uv, ctx) => (
    <ActionRow
      testid="SandboxCrossLinkRow"
      label="Command sandbox"
      description="Isolation, network and filesystem rules live on the Claude engine page."
      engine="claude"
      action="Configure"
      onAction={() => ctx?.navigate({ page: 'claude', group: 'sandbox' })}
    />
  )
}

/**
 * A group where two of three engines would show nothing gets ONE dimmed
 * explanatory row, never an empty segment (ADR-065).
 */
const OTHER_ENGINE_PERMISSIONS: SettingItem = {
  key: 'otherEnginePermissions',
  label: 'opencode and pi',
  keywords: 'opencode pi permission rules autonomy mapping',
  render: () => (
    <SettingRow
      testid="OtherEnginePermissionsRow"
      dimmed
      label="opencode and pi"
      description="Map the autonomy mode above onto their own permission rulesets. Nothing to configure."
    />
  )
}

/** Advanced › About. The version footer the redesign removed lives here now. */
const VERSIONS: SettingItem = {
  key: 'versions',
  label: 'Versions',
  keywords: 'version about build claudeui cli release',
  render: (_s, _u, _e, _ue, _v, _uv, ctx) => {
    const app = ctx?.versionInfo?.appVersion
    const cli = ctx?.versionInfo?.cliVersion
    return (
      <div data-testid="AboutVersionsRows" className="divide-y divide-border/55">
        <SettingRow testid="AboutVersionsRows.row" dataId="app" label="ClaudeUI">
          <span className="text-[12px] text-text-secondary tabular-nums">
            {app ? (/^\d/.test(app) ? `v${app}` : app) : '…'}
          </span>
        </SettingRow>
        <SettingRow testid="AboutVersionsRows.row" dataId="cli" label="Claude Code CLI">
          <span className="text-[12px] text-text-secondary tabular-nums">{cli ?? '…'}</span>
        </SettingRow>
      </div>
    )
  }
}

/** Item keys defined in THIS file rather than pulled from `SECTIONS`. */
export const PAGE_LOCAL_ITEMS: readonly SettingItem[] = [
  SANDBOX_CROSS_LINK,
  OTHER_ENGINE_PERMISSIONS,
  VERSIONS
]

// ── Icons (14px, stroke 1.8 — the rail size on the boards) ───────────

function icon(children: React.ReactNode): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const ICON_APPEARANCE = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
  </>
)
const ICON_CHAT = icon(<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />)
const ICON_SESSIONS = icon(
  <>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </>
)
const ICON_ADVANCED = icon(
  <>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </>
)
const ICON_MODELS = icon(
  <>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </>
)
const ICON_DISPATCH = icon(
  <>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 014-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 01-4 4H3" />
  </>
)
const ICON_MOCKUPS = icon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </>
)
const ICON_REMOTE = icon(
  <>
    <path d="M5 12.55a11 11 0 0114.08 0" />
    <path d="M1.42 9a16 16 0 0121.16 0" />
    <path d="M8.53 16.11a6 6 0 016.95 0" />
    <circle cx="12" cy="20" r="1" />
  </>
)
const ICON_CLAUDE = icon(<path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />)
const ICON_OPENCODE = icon(
  <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>
)
const ICON_PI = icon(
  <>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="8" y1="7" x2="8" y2="19" />
    <line x1="16" y1="7" x2="16" y2="19" />
  </>
)

/** `engines/<engine>.json` — the storage tag of a per-engine group. */
const engineFile = (engine: EngineId): string => `engines/${engine}.json`

// ── The 11 pages ─────────────────────────────────────────────────────

export const PAGES: SettingsPage[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    rail: 'app',
    icon: ICON_APPEARANCE,
    description: 'How ClaudeUI looks.',
    groups: [
      { id: 'theme', label: 'Theme & type', items: itemsOf('appearance') },
      { id: 'layout', label: 'Chat layout', items: itemsOf('chat') },
      { id: 'diff', label: 'Diff viewer', items: itemsOf('diff') },
      { id: 'status-line', label: 'Status line', items: itemsOf('status-line') },
      { id: 'git-panel', label: 'Git panel', items: itemsOf('git', ['gitPanelLayout']) }
    ]
  },
  {
    id: 'chat',
    label: 'Chat',
    rail: 'app',
    icon: ICON_CHAT,
    description: 'How the conversation renders and what you can do from it.',
    groups: [
      {
        id: 'tool-output',
        label: 'Tool output',
        items: itemsOf('tool-output', [
          'expandToolCalls',
          'expandReadResults',
          'hideToolInput',
          'toolOutputMaxChars'
        ])
      },
      { id: 'thinking', label: 'Thinking', items: itemsOf('tool-output', ['expandThinking']) },
      { id: 'voice', label: 'Voice input', items: itemsOf('voice') },
      { id: 'git-actions', label: 'Git actions', items: itemsOf('git', ['gitCommitMode']) }
    ]
  },
  {
    id: 'sessions',
    label: 'Sessions & autonomy',
    rail: 'app',
    icon: ICON_SESSIONS,
    description:
      'How new sessions start, what the agent may do on its own, and how long chats are kept.',
    groups: [
      {
        id: 'autonomy',
        label: 'Autonomy default',
        badge: 'All engines',
        items: itemsOf('autonomy')
      },
      {
        id: 'permissions',
        label: 'Permissions',
        storage: '~/.claude/settings.json',
        items: [...itemsOf('permissions'), SANDBOX_CROSS_LINK, OTHER_ENGINE_PERMISSIONS]
      },
      {
        id: 'judge',
        label: 'Auto-mode judge',
        storage: engineFile,
        byEngine: {
          opencode: itemsOf('opencode-automode'),
          pi: itemsOf('pi-automode')
        }
      },
      { id: 'retention', label: 'Idle & retention', items: itemsOf('session') }
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    rail: 'app',
    icon: ICON_ADVANCED,
    description: 'Diagnostics, polling, and version information.',
    groups: [
      { id: 'logging', label: 'Logging', items: itemsOf('logging') },
      { id: 'usage', label: 'Usage polling', items: itemsOf('usage') },
      { id: 'about', label: 'About', items: [VERSIONS] }
    ]
  },
  {
    id: 'models',
    label: 'Models & providers',
    rail: 'features',
    icon: ICON_MODELS,
    description:
      'Which providers ClaudeUI can reach, and which model each engine starts a session with.',
    groups: [
      {
        id: 'providers',
        label: 'Providers',
        badge: 'Shared',
        items: itemsOf('shared-providers')
      },
      { id: 'providers-opencode', label: 'opencode providers', items: itemsOf('vendor-opencode') },
      { id: 'providers-pi', label: 'pi providers', items: itemsOf('vendor-pi') },
      {
        id: 'defaults',
        label: 'Default models',
        byEngine: {
          claude: itemsOf('effortDefaults'),
          opencode: itemsOf('opencode-models'),
          pi: itemsOf('pi-config-models')
        }
      },
      {
        id: 'anthropic',
        label: 'Anthropic endpoint',
        storage: 'vendors/anthropic.json',
        items: itemsOf('vendor-anthropic')
      },
      { id: 'accounts', label: 'Accounts', items: itemsOf('accounts') }
    ]
  },
  {
    id: 'dispatch',
    label: 'Cross-engine dispatch',
    rail: 'features',
    icon: ICON_DISPATCH,
    description:
      'A session on one engine can hand a task to an agent on another. Configure what each engine accepts when it is the target.',
    groups: [
      {
        id: 'into',
        label: 'Dispatch into',
        storage: engineFile,
        byEngine: {
          claude: itemsOf('claude-dispatch'),
          opencode: itemsOf('opencode-dispatch')
        }
      }
    ]
  },
  {
    id: 'mockups',
    label: 'Mockups',
    rail: 'features',
    icon: ICON_MOCKUPS,
    description: 'Sandboxed HTML mockups the agent renders in the app.',
    groups: [{ id: 'network', label: 'Network', items: itemsOf('mockup') }]
  },
  {
    id: 'remote',
    label: 'Remote access',
    rail: 'features',
    icon: ICON_REMOTE,
    description: "Reach this machine's sessions from a phone or browser.",
    groups: [
      { id: 'follow', label: 'Follow', items: itemsOf('remote', ['remoteFollowActions']) },
      { id: 'server', label: 'Server', items: itemsOf('remote', ['remoteServerConfig']) }
    ]
  },
  {
    id: 'claude',
    label: 'Claude',
    rail: 'engines',
    icon: ICON_CLAUDE,
    engine: 'claude',
    description: "Claude Code's launch parameters. Permission rules are on Sessions & autonomy.",
    groups: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        requires: 'sandbox',
        storage: 'engines/claude.json',
        items: itemsOf('sandbox')
      },
      {
        id: 'proxy',
        label: 'Proxy',
        requires: 'proxy',
        storage: 'engines/claude.json',
        items: itemsOf('proxy')
      }
    ]
  },
  {
    id: 'opencode',
    label: 'opencode',
    rail: 'engines',
    icon: ICON_OPENCODE,
    engine: 'opencode',
    description:
      "opencode's own configuration. Only the field you change is written; comments and other keys are kept.",
    groups: [
      {
        id: 'session',
        label: 'Session behaviour',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-session')
      },
      {
        id: 'tool-output',
        label: 'Tool output limits',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-tool-output')
      },
      {
        id: 'attachments',
        label: 'Image attachments',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-attachments')
      },
      {
        id: 'workspace',
        label: 'Workspace',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-workspace')
      },
      {
        id: 'tools',
        label: 'Tools & integrations',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-tools')
      },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-diagnostics')
      },
      {
        id: 'managed',
        label: 'Managed',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-managed')
      },
      {
        id: 'agents',
        label: 'Agents',
        storage: 'agents/*.md',
        items: itemsOf('opencode-agents')
      },
      {
        id: 'raw',
        label: 'Raw config',
        storage: 'opencode.jsonc',
        items: itemsOf('opencode-config')
      }
    ]
  },
  {
    id: 'pi',
    label: 'pi',
    rail: 'engines',
    icon: ICON_PI,
    engine: 'pi',
    description:
      "pi's own configuration. Only the field you change is written; other keys are kept.",
    groups: [
      {
        id: 'session',
        label: 'Session behaviour',
        storage: 'settings.json',
        items: itemsOf('pi-config-session')
      },
      {
        id: 'tools',
        label: 'Tools & shell',
        storage: 'settings.json',
        items: itemsOf('pi-config-tools')
      },
      {
        id: 'attachments',
        label: 'Image attachments',
        storage: 'settings.json',
        items: itemsOf('pi-config-images')
      },
      {
        id: 'workspace',
        label: 'Workspace & trust',
        storage: 'settings.json',
        items: itemsOf('pi-config-workspace')
      },
      {
        id: 'network',
        label: 'Network & telemetry',
        storage: 'settings.json',
        items: itemsOf('pi-config-network')
      },
      {
        id: 'raw',
        label: 'Raw config',
        storage: 'settings.json',
        items: itemsOf('pi-config-raw')
      }
    ]
  }
]

// ── Lookups ──────────────────────────────────────────────────────────

const PAGE_BY_ID = new Map<SettingsPageId, SettingsPage>(PAGES.map((p) => [p.id, p]))

export function pageOf(id: SettingsPageId): SettingsPage {
  const page = PAGE_BY_ID.get(id)
  if (!page) throw new Error(`settings-pages: no page "${id}"`)
  return page
}

/**
 * Engines pages declare an engine, so a group can be gated on one of its
 * capabilities (the Claude sandbox/proxy launch params). Pure — no hooks — so
 * the model tests can call it with a stub.
 */
export function visibleGroups(
  page: SettingsPage,
  caps?: EngineCapabilities | null
): SettingsGroup[] {
  const resolved =
    caps === undefined ? (page.engine ? engineMeta(page.engine).capabilities : null) : caps
  return page.groups.filter((g) => !g.requires || (resolved ? resolved[g.requires] === true : true))
}

/** The engines a byEngine group offers, always in claude → opencode → pi order. */
const ENGINE_ORDER: readonly EngineId[] = ['claude', 'opencode', 'pi']

export function enginesOf(group: SettingsGroup): EngineId[] {
  if (!group.byEngine) return []
  return ENGINE_ORDER.filter((e) => group.byEngine?.[e] !== undefined)
}

/** The items a group renders for the selected engine (or its plain list). */
export function itemsFor(group: SettingsGroup, engine: EngineId | undefined): SettingItem[] {
  if (group.items) return group.items
  if (!group.byEngine) return []
  const chosen = engine && group.byEngine[engine] ? engine : enginesOf(group)[0]
  return (chosen && group.byEngine[chosen]) || []
}

/** The storage tag to show, resolved against the group's selected engine. */
export function storageOf(group: SettingsGroup, engine: EngineId | undefined): string | undefined {
  if (typeof group.storage !== 'function') return group.storage
  const chosen = engine && group.byEngine?.[engine] ? engine : enginesOf(group)[0]
  return chosen ? group.storage(chosen) : undefined
}

// ── Legacy section ↔ target mapping ──────────────────────────────────

/**
 * Where each pre-ADR-065 section now lives. Every id in `SECTIONS` is present
 * (guarded by the model test); a section whose items were split across two
 * groups is filed under the group that owns its FIRST item, which is all the
 * mobile adapter and the legacy deep links need.
 */
export const SECTION_TARGET: Readonly<Record<string, { page: SettingsPageId; group: string }>> = {
  appearance: { page: 'appearance', group: 'theme' },
  chat: { page: 'appearance', group: 'layout' },
  diff: { page: 'appearance', group: 'diff' },
  'status-line': { page: 'appearance', group: 'status-line' },
  git: { page: 'appearance', group: 'git-panel' },

  'tool-output': { page: 'chat', group: 'tool-output' },
  voice: { page: 'chat', group: 'voice' },

  autonomy: { page: 'sessions', group: 'autonomy' },
  permissions: { page: 'sessions', group: 'permissions' },
  'opencode-automode': { page: 'sessions', group: 'judge' },
  'pi-automode': { page: 'sessions', group: 'judge' },
  session: { page: 'sessions', group: 'retention' },

  logging: { page: 'advanced', group: 'logging' },
  usage: { page: 'advanced', group: 'usage' },

  'shared-providers': { page: 'models', group: 'providers' },
  'vendor-opencode': { page: 'models', group: 'providers-opencode' },
  'vendor-pi': { page: 'models', group: 'providers-pi' },
  effortDefaults: { page: 'models', group: 'defaults' },
  'opencode-models': { page: 'models', group: 'defaults' },
  'pi-config-models': { page: 'models', group: 'defaults' },
  'vendor-anthropic': { page: 'models', group: 'anthropic' },
  accounts: { page: 'models', group: 'accounts' },

  'claude-dispatch': { page: 'dispatch', group: 'into' },
  'opencode-dispatch': { page: 'dispatch', group: 'into' },

  mockup: { page: 'mockups', group: 'network' },

  remote: { page: 'remote', group: 'server' },

  sandbox: { page: 'claude', group: 'sandbox' },
  proxy: { page: 'claude', group: 'proxy' },

  'opencode-session': { page: 'opencode', group: 'session' },
  'opencode-tool-output': { page: 'opencode', group: 'tool-output' },
  'opencode-attachments': { page: 'opencode', group: 'attachments' },
  'opencode-workspace': { page: 'opencode', group: 'workspace' },
  'opencode-tools': { page: 'opencode', group: 'tools' },
  'opencode-diagnostics': { page: 'opencode', group: 'diagnostics' },
  'opencode-managed': { page: 'opencode', group: 'managed' },
  'opencode-agents': { page: 'opencode', group: 'agents' },
  'opencode-config': { page: 'opencode', group: 'raw' },

  'pi-config-session': { page: 'pi', group: 'session' },
  'pi-config-tools': { page: 'pi', group: 'tools' },
  'pi-config-images': { page: 'pi', group: 'attachments' },
  'pi-config-workspace': { page: 'pi', group: 'workspace' },
  'pi-config-network': { page: 'pi', group: 'network' },
  'pi-config-raw': { page: 'pi', group: 'raw' }
}

// ── Search ───────────────────────────────────────────────────────────

export interface SettingsSearchHit {
  page: SettingsPage
  group: SettingsGroup
  /** Set when the hit came from a `byEngine` list. */
  engine?: EngineId
  item: SettingItem
}

const lc = (s: string | undefined): string => (s ?? '').toLowerCase()

/**
 * Global across all pages — the scope-local search was one of the defects
 * ADR-065 lists. Matches the page label, the group label, the item label and the
 * item's keywords, so "sandbox" finds the Claude page (through its Sandbox
 * group) without the user having to know it lives there.
 *
 * Descriptions are deliberately NOT matched: a page's one-liner is prose, so
 * "How ClaudeUI looks." would make half a dozen common words select the whole
 * Appearance page.
 */
export function searchSettings(query: string): SettingsSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SettingsSearchHit[] = []
  for (const page of PAGES) {
    const pageHit = lc(page.label).includes(q)
    for (const group of visibleGroups(page)) {
      const groupHit = pageHit || lc(group.label).includes(q)
      const push = (item: SettingItem, engine?: EngineId): void => {
        if (groupHit || lc(item.label).includes(q) || lc(item.keywords).includes(q)) {
          hits.push({ page, group, engine, item })
        }
      }
      if (group.items) for (const item of group.items) push(item)
      else
        for (const engine of enginesOf(group))
          for (const item of group.byEngine![engine]!) push(item, engine)
    }
  }
  return hits
}

// ── Mobile adapter (phase 1 only) ────────────────────────────────────

/**
 * A `{ page, group }` target, expressed in the legacy scope/section vocabulary
 * the MOBILE view still runs on this phase (ADR-065 phase 5 replaces it).
 *
 * Resolution order: the first section filed under that exact group, else the
 * first section anywhere on that page, else the Common tab. The scope comes
 * from `SECTION_SCOPE_MAP` rather than a second copy of the ownership rules —
 * the two must not be able to drift.
 */
export function targetToLegacy(target: SettingsTarget): {
  scope: SettingsScope
  section?: string
} {
  const entries = Object.entries(SECTION_TARGET)
  const exact = target.group
    ? entries.find(([, t]) => t.page === target.page && t.group === target.group)
    : undefined
  const found = exact ?? entries.find(([, t]) => t.page === target.page)
  if (!found) return { scope: 'common' }
  return { scope: SECTION_SCOPE_MAP.get(found[0]) ?? 'common', section: found[0] }
}
