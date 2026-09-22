import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { useSidebarCollapsed } from '../../SessionView'
import { WindowControls } from '../../WindowControls'
import {
  WORKTREE_MARK,
  WorktreePill,
  WorktreePopover,
  useWorktreePillName
} from '../../git/WorktreePill'
import { BRANCH_MARK, GitBranchPill, useBranchPillName } from '../../git/GitBranchPill'
import { GitBranchDropdown } from '../../git/GitBranchDropdown'
import { GitChangesPill } from '../../git/GitChangesPill'
import { AuthPillSlot } from '../AuthPill'
import { useEscapeLayer } from '../../shared/use-escape-layer'
import {
  OVERFLOW_FROM_TIER1,
  OVERFLOW_FROM_TIER2,
  TIER1_HIDE,
  TIER1_ROW_HIDE,
  TIER2_HIDE,
  TIER2_ROW_HIDE
} from './top-bar-tiers'
import { PermissionsDialog } from '../../PermissionsDialog'
import { SkillsDialog } from '../../SkillsDialog'
import { McpDialog } from '../../McpDialog'
import { EngineLogo } from '../../shared/EngineLogo'
import { toggleTerminalPanel } from '../../terminal/toggle-terminal'
import { useTerminalAvailability } from '../../terminal/terminal-availability'
import { useIdeAvailability } from '../ide-availability'
import { IdeUnavailableDialog } from '../IdeUnavailableDialog'
import { shortModelName } from '../../usage/usage-utils'
import { COST_UNKNOWN, formatCostOrUnknown, formatCostUsd } from '../../../utils/cost'
import { ideLaunchPageHtml } from '../../../../../shared/ide-launch-page'
import { displayCwd } from '../../../../../shared/display-path'
import {
  ideUnavailableReason,
  isIdeUnavailableError,
  type IdeUnavailableReason
} from '../../../../../shared/remote-protocol'

/** Format a millisecond duration as "Ns", "Nm Ns", or "Nh Nm" — seconds drop
 *  out at the hour scale where they're noise. Shared by the Session time /
 *  API time tooltip rows. */
function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60000)}m`
}

/**
 * Display label for a dispatched (cross-engine, Slice C) cost row. Reuses
 * shortModelName — it already recognizes Claude family names anywhere in the
 * id, so a dispatched Claude target (e.g. "anthropic/claude-opus-4-6") comes
 * back clean. For a non-Claude id shortModelName can't shorten (e.g. an
 * opencode "providerID/modelID" target like "openai/gpt-5-codex"), it returns
 * the raw string unchanged (by design — see its own doc comment) — strip the
 * redundant provider prefix here instead of teaching shortModelName about
 * dispatch-only id shapes.
 */
function dispatchedModelLabel(modelId: string): string {
  const short = shortModelName(modelId)
  const slash = short.indexOf('/')
  return slash === -1 ? short : short.slice(slash + 1)
}

/**
 * The host's own words about a typed `ide:mint-entry` refusal, re-read AFTER the
 * failure (ADR-064 §5).
 *
 * The refusal itself is deliberately detail-free — `ide-unavailable:<reason>`
 * and nothing more, so a connection that has not earned one cannot use it as a
 * host-path oracle. The DETAIL lives on `ide:availability`, which is a `config`
 * query any signed-in client may ask, so the explain-why dialog fetches it
 * separately rather than the wire carrying it to clients that never open a
 * dialog.
 *
 * Never throws and never fabricates: an undefined result means the host said
 * nothing, and the dialog renders its reason copy alone.
 */
async function ideFailureDetail(reason: IdeUnavailableReason): Promise<string | undefined> {
  // Neither of these has a detail to fetch — the toggle is off, or the origin is
  // excluded by policy — so skip a round-trip whose answer is already known.
  if (reason === 'toggle-off' || reason === 'origin-not-allowed') return undefined
  try {
    const fresh = await window.api.ideAvailability()
    if (reason === 'spawn-failed') return fresh.lastError
    return fresh.probe.ok ? undefined : fresh.probe.detail
  } catch {
    return undefined
  }
}

/**
 * ONE control, rendered on two surfaces: a bar button above its tier's
 * threshold and a ⋯ row below it.
 *
 * The two used to be separately written JSX, and they had already drifted —
 * two labels for Permissions, five duplicated icon bodies, and a `cwd` the menu
 * required and the Terminal button did not, so a narrow session with no working
 * directory had no way into the terminal at all (the button hidden by width,
 * the ⋯ suppressed because the list came back empty). A gate and a label can
 * now be written only once; the marks are one drawing each, except VS Code's,
 * whose two surfaces genuinely draw different art and now do so side by side.
 */
interface BarControl {
  id: string
  /** The one name this control has: the ⋯ row's text and the bar's tooltip. */
  label: string
  /** Appended to the BAR tooltip only — a menu row has no room for a binding. */
  keyHint?: string
  /** Which tier decides which of the two surfaces is on screen. */
  tier: 1 | 2
  menuTestId: string
  menuIcon: React.JSX.Element
  /**
   * The bar form, when this control renders one HERE. Tier 1's two pills are
   * stateful components that render themselves — the pill IS the bar form — so
   * their descriptors carry a menu row alone.
   */
  bar?: { testId: string; content: React.JSX.Element; className?: string }
  /** This control's OWN gate: the single condition both surfaces read. */
  available: boolean
  onSelect: () => void
}

/** The flat marks, drawn at whichever size their surface uses — the bar's row
 *  is tighter than the menu's, and that is the only difference between them. */
function strokeIcon(size: number, body: React.ReactNode): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {body}
    </svg>
  )
}

const TERMINAL_MARK = (
  <>
    <path d="M4 17l6-6-6-6" />
    <path d="M12 19h8" />
  </>
)
const SKILLS_MARK = <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
const MCP_MARK = (
  <>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8Z" />
  </>
)
const PERMISSIONS_MARK = <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
/** VS Code's menu mark: the flat silhouette, since a 13px row has no use for
 *  the bar button's three-tone brand logo (which colours on hover). */
const VSCODE_MENU_MARK = (
  <svg width="13" height="13" viewBox="0 0 100 100" fill="none" className="shrink-0">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M70.912 99.317a6.223 6.223 0 004.96-.19l20.589-9.907A6.25 6.25 0 00100 83.587V16.413a6.25 6.25 0 00-3.539-5.633L75.872.873a6.226 6.226 0 00-7.109 1.318L29.355 38.044 12.187 25.02a4.162 4.162 0 00-5.318.27L1.382 30.308a4.168 4.168 0 00-.005 6.146L16.674 50 1.377 63.546a4.168 4.168 0 00.005 6.146l5.487 5.018a4.162 4.162 0 005.318.27l17.168-13.024 39.408 35.853a6.213 6.213 0 002.149 1.508zM75.015 27.3L45.11 50l29.906 22.7V27.3z"
      fill="currentColor"
    />
  </svg>
)
/** The bar button's own mark: the three-tone logo that colours on hover. */
const VSCODE_BAR_MARK = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 100 100"
    fill="none"
    className="shrink-0 relative top-[1px] transition-opacity"
  >
    <mask id="vsc" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M70.912 99.317a6.223 6.223 0 004.96-.19l20.589-9.907A6.25 6.25 0 00100 83.587V16.413a6.25 6.25 0 00-3.539-5.633L75.872.873a6.226 6.226 0 00-7.109 1.318L29.355 38.044 12.187 25.02a4.162 4.162 0 00-5.318.27L1.382 30.308a4.168 4.168 0 00-.005 6.146L16.674 50 1.377 63.546a4.168 4.168 0 00.005 6.146l5.487 5.018a4.162 4.162 0 005.318.27l17.168-13.024 39.408 35.853a6.213 6.213 0 002.149 1.508zM75.015 27.3L45.11 50l29.906 22.7V27.3z"
        fill="#fff"
      />
    </mask>
    <g mask="url(#vsc)">
      <path
        d="M96.461 10.796L75.857.873a6.23 6.23 0 00-7.108 1.318l-67.37 61.354a4.167 4.167 0 00.006 6.146l5.487 5.018a4.163 4.163 0 005.318.27L96.47 10.87l-.009-.073z"
        className="fill-current group-hover:fill-[#0065A9] transition-colors"
      />
      <path
        d="M96.461 89.204L75.857 99.127a6.23 6.23 0 01-7.108-1.318L1.38 36.455a4.167 4.167 0 01.006-6.146l5.487-5.018a4.163 4.163 0 015.318-.27L96.47 89.13l-.009.073z"
        className="fill-current group-hover:fill-[#007ACC] transition-colors"
      />
      <path
        d="M75.857 99.127a6.226 6.226 0 01-7.108-1.318C73.952 102.61 81.25 98.28 81.25 91.667V8.333c0-6.614-7.298-10.943-12.5-6.142a6.226 6.226 0 017.108-1.318l20.604 9.923A6.25 6.25 0 01100 16.43v67.14a6.25 6.25 0 01-3.538 5.634l-20.605 9.923z"
        className="fill-current group-hover:fill-[#1F9CF0] transition-colors"
      />
    </g>
  </svg>
)

export function TopBar({ hasContent }: { hasContent: boolean }): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const sdkSessionId = useActiveSession((s) => s.status.sessionId)
  const statusLine = useActiveSession((s) => s.statusLine)
  const fallbackCost = useActiveSession((s) => s.status.totalCostUsd)
  const engineId = useActiveSession((s) => s.status.engineId)
  const billingType = useActiveSession((s) => s.status.account?.billingType)
  const canUseMcp = useActiveSession((s) => s.status.capabilities.canUseMcp)
  const capSkills = useActiveSession((s) => s.status.capabilities.skills)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const customTitle = useSessionStore((s) =>
    activeSessionId ? s.customTitles[activeSessionId] : undefined
  )
  const {
    collapsed: sidebarCollapsed,
    toggle: toggleSidebar,
    isMobile: isMobileCtx
  } = useSidebarCollapsed()
  const showWelcome = useSessionStore((s) => s.showWelcome)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const isMac = window.api.platform === 'darwin'
  const leftPadding = isMobileCtx ? 8 : sidebarCollapsed && isMac ? 148 / uiFontScale : 13
  const terminalAvailability = useTerminalAvailability()
  // Null on the desktop by construction — the desktop VSCode button is the
  // `vscode://` deep link and consults no host answer (ADR-064 §5).
  const { availability: ideAvailability, refresh: refreshIdeAvailability } = useIdeAvailability()
  /**
   * The colour scheme the proxied workbench should open in (ADR-064 polish).
   *
   * ClaudeUI's palette is a three-member union and VS Code's is two, so the
   * mapping is here rather than on the wire: `monokai` is a dark scheme, and
   * anything that is not explicitly `light` is dark — a future ClaudeUI theme
   * lands on the safer side without a protocol change.
   */
  const ideThemeKind: 'dark' | 'light' =
    useSessionStore((s) => s.settings.theme) === 'light' ? 'light' : 'dark'
  const isWeb = window.api?.platform === 'web'
  // Tooltip text only. `window.api.platform` is 'web' for every host OS, so the
  // UA hint is the only signal a browser client has about its keyboard. Both
  // bindings work everywhere regardless — this just names the reachable one.
  const isMacKeyboard =
    isMac || (window.api.platform === 'web' && /mac/i.test(navigator.platform ?? ''))
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [infoHover, setInfoHover] = useState(false)
  const infoLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)

  /**
   * Settings' one link INTO the MCP surface (ADR-068 §6: the Codex page's MCP
   * group states how many servers a thread inherits and sends the user here to
   * change them).
   *
   * An event rather than a prop for the same reason `open-settings` is one: the
   * dialog's state lives in this bar, the link lives inside a static settings
   * group definition several trees away, and the two hosts of the settings
   * dialog close themselves on the same event so the MCP dialog is not opened
   * behind one.
   */
  useEffect(() => {
    const handler = (): void => setMcpOpen(true)
    window.addEventListener('open-mcp-servers', handler)
    return () => window.removeEventListener('open-mcp-servers', handler)
  }, [])
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  const overflowButtonRef = useRef<HTMLButtonElement>(null)
  /** Which tier-1 panel the ⋯ opened, if any — the pills' own, not a copy. */
  const [gitPopover, setGitPopover] = useState<'branch' | 'worktree' | null>(null)
  const branchName = useBranchPillName()
  const worktreeName = useWorktreePillName()
  /** The typed IDE refusal currently being explained, or null. */
  const [ideDialog, setIdeDialog] = useState<{
    reason: IdeUnavailableReason
    detail?: string
  } | null>(null)
  /**
   * The one IDE failure that is NOT a typed refusal and does not earn a modal:
   * the browser refused the pre-opened tab. Nothing about the host is wrong, so
   * a dialog explaining the security model would be a lie — the operator needs
   * one line about their own pop-up blocker instead.
   */
  const [ideError, setIdeError] = useState<string | null>(null)

  /**
   * The VSCode button's two completely different jobs (ADR-064 §5).
   *
   * DESKTOP is unchanged and stays unchanged: `vscode://file/…` handed to the
   * OS, no host question asked, nothing about the remote IDE involved.
   *
   * WEB mints a one-time entry under `/vscode` and navigates a second tab into
   * the proxied workbench. Three things about the order here are load-bearing:
   *
   *  1. **Pre-flight on the answer already held.** An excluded origin and a
   *     missing CLI are states the mint would only re-discover, and opening a
   *     tab for them would strand a blank one behind the dialog.
   *  2. **The CEREMONY comes before the tab** (ADR-064 polish). A step-up
   *     renders in THIS tab, so pre-opening the workbench tab first pushed the
   *     app into the background and left the operator staring at "Opening VS
   *     Code…" while the prompt they had to answer was somewhere behind it.
   *     Running the ceremony first costs the click's user gesture — see (3).
   *  3. **`window.open` runs SYNCHRONOUSLY on the click** whenever it can. A
   *     pop-up blocker kills a `window.open` issued after an `await`, so on the
   *     no-ceremony path (the common one) the tab is still claimed on the
   *     click's own gesture and navigated once the URL lands — the regression
   *     the component test asserts by call order. After a ceremony that gesture
   *     is spent, so a refused tab there is EXPECTED and gets its own copy: the
   *     grant is now held, and the second click takes the synchronous path.
   *  4. **The invoke gate is still the backstop.** It intercepts `needs-step-up`
   *     on ANY invoke and retries once, which covers the rare decay race between
   *     the availability answer and the mint; a cancelled ceremony there rethrows
   *     the ORIGINAL refusal, which is not an IDE refusal and therefore closes
   *     the tab in silence — the operator just declined, and has nothing to be
   *     told.
   */
  const handleOpenVSCode = useCallback(async (): Promise<void> => {
    if (!cwd) return
    if (!isWeb) {
      window.api.openInVSCode(cwd)
      return
    }
    setIdeError(null)
    if (ideAvailability && !ideAvailability.originAllowed) {
      setIdeDialog({ reason: ideAvailability.originReason ?? 'origin-not-allowed' })
      return
    }
    if (ideAvailability && !ideAvailability.probe.ok) {
      setIdeDialog({
        reason: ideAvailability.probe.reason,
        ...(ideAvailability.probe.detail ? { detail: ideAvailability.probe.detail } : {})
      })
      return
    }
    let ceremonyRan = false
    if (ideAvailability?.needsStepUp) {
      // The web bundle installs this before React mounts; the desktop build has
      // no ceremony at all, hence the optional access rather than an import —
      // TerminalPanel's exact idiom. A build WITHOUT the global falls through to
      // the old order, where the invoke gate runs the ceremony instead: degrading
      // to the previous behaviour beats a button that silently does nothing.
      const request = (
        window as unknown as { __STEP_UP_REQUEST__?: (channel: string) => Promise<boolean> }
      ).__STEP_UP_REQUEST__
      if (request) {
        const granted = await request('ide:mint-entry')
        // Cancelled or failed. Silent, exactly as a cancelled ceremony has always
        // been: the operator declined, and has nothing to be told.
        if (!granted) return
        ceremonyRan = true
        // The answer this flow was gated on is now stale in the one field that
        // matters, and nothing else re-queries between here and the mint.
        await refreshIdeAvailability()
      }
    }
    const tab = window.open('', '_blank')
    if (!tab) {
      // NEVER navigate this tab instead: the operator would lose the session
      // they are in to a workbench they did not ask to replace it with.
      setIdeError(
        ceremonyRan
          ? // Not a pop-up-blocker problem to solve: the ceremony consumed the
            // click's user gesture. The grant is held now, so the next click
            // opens the tab synchronously and works.
            'VS Code unlocked — click the button again to open it.'
          : 'Allow pop-ups for this site to open VS Code.'
      )
      return
    }
    try {
      // So the round-trip isn't a bare tab — and not a bare WHITE tab on a dark
      // client: the shared launch page (spinner + label, the session's scheme),
      // static variant since this tab is navigated by us, not by a refresh.
      // Best-effort by construction: a tab we cannot write to is still a tab we
      // can navigate.
      tab.document.write(ideLaunchPageHtml(ideThemeKind, 'static'))
      tab.document.close()
    } catch {
      /* see above */
    }
    try {
      const { url } = await window.api.ideMintEntry(cwd, ideThemeKind)
      // RELATIVE by contract — this page's own origin is the one the entry
      // cookie is scoped to, so the host never has to guess what it is.
      tab.location.href = url
    } catch (err) {
      try {
        tab.close()
      } catch {
        /* the operator may have closed it already */
      }
      if (!isIdeUnavailableError(err)) {
        console.warn('[TopBar] IDE entry mint failed:', err)
        return
      }
      const reason = ideUnavailableReason(err)
      if (!reason) {
        // A typed refusal that lost its suffix. There is no honest copy for
        // "unknown", so say the little that is true rather than picking one.
        console.warn('[TopBar] IDE refusal carried no reason:', err)
        setIdeError('Could not open VS Code.')
        return
      }
      const detail = await ideFailureDetail(reason)
      setIdeDialog({ reason, ...(detail ? { detail } : {}) })
    }
  }, [cwd, isWeb, ideAvailability, ideThemeKind, refreshIdeAvailability])

  /**
   * Every collapsible control, in the bar's own left-to-right order, described
   * ONCE (see {@link BarControl}).
   *
   * Each `available` is that control's whole gate and nothing else's: the
   * Terminal's is the host's availability answer alone, because nothing about a
   * shell needs a working directory (`toggle-terminal.ts` opens the panel and
   * spawns nothing without one, and the panel's empty state is the affordance
   * there). Skills, MCP and Permissions genuinely do need a `cwd` — they
   * configure a project — and say so individually.
   *
   * An empty list hides the ⋯ button entirely rather than opening an empty
   * popover.
   */
  const controls = useMemo<BarControl[]>(() => {
    const all: BarControl[] = [
      {
        id: 'vscode',
        tier: 2,
        label: 'Open in VS Code',
        menuTestId: 'TopBar.overflowMenuVSCode',
        menuIcon: VSCODE_MENU_MARK,
        bar: {
          testId: 'TopBar.openVSCode',
          // `group` for the logo's hover colours; baseline because this is the
          // one bar button with a text label beside its mark.
          className: 'group items-baseline',
          content: (
            <>
              {VSCODE_BAR_MARK}
              <span>VSCode</span>
            </>
          )
        },
        // On the desktop the `vscode://` deep link is always available; on web
        // only once the host says the owner turned the remote IDE on (a null
        // "still asking" renders nothing rather than flashing in and out).
        // Origin / CLI refusals deliberately do NOT hide it: ADR-064 rules those
        // must be EXPLAINED, so the control stays and opens the dialog.
        available: !!cwd && (!isWeb || ideAvailability?.allowed === true),
        onSelect: () => void handleOpenVSCode()
      },
      {
        id: 'terminal',
        tier: 2,
        label: 'Terminal',
        // The bar has room to name the binding; a menu row does not, and the
        // binding is unreachable in a browser anyway (macOS owns Cmd+`, Edge
        // swallows Ctrl+`), which is why the visible control exists at all.
        keyHint: isMacKeyboard ? '(⌥`)' : '(Ctrl+`)',
        menuTestId: 'TopBar.overflowMenuTerminal',
        menuIcon: strokeIcon(13, TERMINAL_MARK),
        bar: { testId: 'TopBar.terminal', content: strokeIcon(13, TERMINAL_MARK) },
        available: terminalAvailability?.allowed === true,
        // The single source of truth the keybinding calls too — the takeover
        // opens off `terminalPanelOpen` exactly as the panel does.
        onSelect: toggleTerminalPanel
      },
      {
        id: 'skills',
        tier: 2,
        label: 'Skills',
        menuTestId: 'TopBar.overflowMenuSkills',
        menuIcon: strokeIcon(13, SKILLS_MARK),
        bar: { testId: 'TopBar.skills', content: strokeIcon(12, SKILLS_MARK) },
        available: !!cwd && capSkills,
        onSelect: () => setSkillsOpen(true)
      },
      {
        id: 'mcp',
        tier: 2,
        label: 'MCP Servers',
        menuTestId: 'TopBar.overflowMenuMcp',
        menuIcon: strokeIcon(13, MCP_MARK),
        bar: { testId: 'TopBar.mcp', content: strokeIcon(13, MCP_MARK) },
        // The MCP dialog manages Claude's .mcp.json servers — Claude-native
        // config, not "hosted tools". Scoped to engineId==='claude' so flipping
        // opencode's hostedMcp capability (Phase 5c, for our injected plugin
        // tools) does NOT surface this Claude-only config UI for opencode.
        available: !!cwd && canUseMcp && engineId === 'claude',
        onSelect: () => setMcpOpen(true)
      },
      {
        id: 'permissions',
        tier: 2,
        // "Permissions", not "Project permissions": the dialog manages the
        // GLOBAL rules as well as this project's.
        label: 'Permissions',
        menuTestId: 'TopBar.overflowMenuPermissions',
        menuIcon: strokeIcon(13, PERMISSIONS_MARK),
        bar: { testId: 'TopBar.permissions', content: strokeIcon(12, PERMISSIONS_MARK) },
        available: !!cwd,
        onSelect: () => setPermissionsOpen(true)
      },
      // Tier 1 is menu-ONLY: the pills are their own bar form, and they are not
      // inert state — the worktree pill copies a path and the branch pill is
      // the app's only fetch / pull / push / switch surface, which tier 1 took
      // away between 768 and 1000 with nowhere to reach it.
      {
        id: 'worktree',
        tier: 1,
        label: `Worktree: ${worktreeName ?? ''}`,
        menuTestId: 'TopBar.overflowMenuWorktree',
        menuIcon: strokeIcon(13, WORKTREE_MARK),
        available: worktreeName !== null,
        onSelect: () => setGitPopover('worktree')
      },
      {
        id: 'branch',
        tier: 1,
        label: `Branch: ${branchName ?? ''}`,
        menuTestId: 'TopBar.overflowMenuBranch',
        menuIcon: strokeIcon(13, BRANCH_MARK),
        available: branchName !== null,
        onSelect: () => setGitPopover('branch')
      }
    ]
    return all.filter((control) => control.available)
  }, [
    cwd,
    capSkills,
    canUseMcp,
    engineId,
    terminalAvailability,
    isWeb,
    isMacKeyboard,
    ideAvailability,
    handleOpenVSCode,
    branchName,
    worktreeName
  ])

  /** Does any tier-1 control have a row? That is what decides how early the ⋯
   *  button is worth showing — outside a repo tier 1 hides nothing, so offering
   *  the button at tier 1's width would open an empty popover. */
  const hasTier1Rows = controls.some((control) => control.tier === 1)
  /** The subset with a bar form of their own; tier 1's pills render themselves. */
  const barControls = controls.filter(
    (control): control is BarControl & { bar: NonNullable<BarControl['bar']> } => !!control.bar
  )

  // Escape goes through the app's ONE stack (use-escape-layer), registered only
  // while the menu is open. A bubble-phase handler of its own let the same press
  // reach every other document listener — closing the settings dialog behind it
  // — and left the menu unclosable whenever any overlay above it stopped the key
  // in capture.
  useEscapeLayer(() => setOverflowOpen(false), true, overflowOpen)

  // Dismiss on outside pointerdown. pointerdown (not click) so a tap that starts
  // outside never lands on whatever the menu was covering.
  useEffect(() => {
    if (!overflowOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [overflowOpen])

  // A resize closes anything hanging off the ⋯. The trigger is a container
  // query, so widening past a threshold takes the button away while its menu is
  // still mounted — and narrowing back would re-reveal a menu nobody opened.
  // Closing beats tracking the width: the bar takes no measurement of its own.
  useEffect(() => {
    if (!overflowOpen && !gitPopover) return
    const onResize = (): void => {
      setOverflowOpen(false)
      setGitPopover(null)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [overflowOpen, gitPopover])

  const infoMouseEnter = useCallback(() => {
    if (infoLeaveTimer.current) clearTimeout(infoLeaveTimer.current)
    setInfoHover(true)
  }, [])
  const infoMouseLeave = useCallback(() => {
    infoLeaveTimer.current = setTimeout(() => setInfoHover(false), 150)
  }, [])

  const displaySessionId = sdkSessionId || activeSessionId
  // null = the engine could not price this session (never "free" — see
  // SessionStatus.totalCostUsd). Kept nullable all the way to the render so
  // the tooltip can say so instead of printing a fabricated $0.00.
  const cost: number | null = statusLine ? statusLine.totalCostUsd : fallbackCost
  const costUnknown = cost === null
  // ADR-071 §2: the engines that separate the two costs send what was BILLED
  // beside the headline. Undefined means the engine does not make the
  // distinction (Claude, Codex) — then the tooltip says nothing extra.
  const billedCostUsd = statusLine?.billedCostUsd
  // A ZERO bill is said in words on the label, never as a figure: `$0.0000` in
  // a row of its own read as a tiny charge, and as one more model line. The
  // Billed row is for the one case words cannot carry: a real amount that is
  // only part of the headline (a session that mixed a plan with an API key).
  const showBilledCost =
    typeof billedCostUsd === 'number' && billedCostUsd > 0 && billedCostUsd !== cost
  const costCovered = billedCostUsd === 0 && cost !== null && cost > 0
  // Covered claims a figure was covered; with an unknown headline there is no
  // figure, but that nothing was billed is still known and worth saying.
  const nothingBilled = billedCostUsd === 0 && cost === null
  const unpricedMessages = statusLine?.unknownCostMessages ?? 0
  const totalDurationMs = statusLine?.totalDurationMs ?? 0
  const totalApiDurationMs = statusLine?.totalApiDurationMs ?? 0
  const turnStartedAtMs = statusLine?.turnStartedAtMs ?? null
  const rawModelCosts = statusLine?.modelCosts ?? []
  // A single-model session's breakdown is redundant with the headline Cost
  // figure — only show it when there's actually more than one line, or a
  // dispatched (cross-engine, Slice C) row is present.
  const showCostBreakdown = rawModelCosts.length >= 2 || rawModelCosts.some((m) => m.dispatched)
  const sortedModelCosts = showCostBreakdown
    ? [...rawModelCosts].sort((a, b) => b.costUsd - a.costUsd)
    : []
  // "Total incl. dispatched" (Slice C): headline own-engine cost + dispatched
  // spend, NEVER sum(breakdown rows) — the headline is the authoritative
  // own-engine figure, so summing rows instead could disagree with it if a
  // per-model recompute ever drifts from the engine's own cumulative total.
  const hasDispatchedCost = rawModelCosts.some((m) => m.dispatched)
  const dispatchedCostUsd = rawModelCosts
    .filter((m) => m.dispatched)
    .reduce((acc, m) => acc + m.costUsd, 0)
  // An unknown headline + a known dispatched figure is still worth showing:
  // the dispatched spend is real money and the row says the rest is unknown,
  // rather than silently reporting the dispatched part as the whole total.
  const totalInclDispatchedUsd = (cost ?? 0) + dispatchedCostUsd
  // A known zero on a FREE vendor is an answer, not an absence: without this
  // the tile vanishes and a free session looks exactly like one nothing is
  // known about. The billing type comes off the session, never from the
  // figure — a known zero on any other billing type stays hidden, because an
  // empty session also totals a known 0 (`totalCosts` docblock) and must not
  // grow a `$0.00` tile before its first turn.
  const costFree = billingType === 'free' && cost === 0
  // Show the Cost tile when there is something to say: a real figure, a
  // dispatched figure, a free vendor's zero, or an explicit "we could not
  // price this".
  const showCost = cost === null || cost > 0 || hasDispatchedCost || costFree

  // Tick every second while the tooltip is open and a turn is in flight, so
  // "Session time" keeps counting up live instead of freezing until the next
  // status-line event.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!infoHover || !turnStartedAtMs) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [infoHover, turnStartedAtMs])

  const sessionDurationMs =
    totalDurationMs + (turnStartedAtMs ? Math.max(0, now - turnStartedAtMs) : 0)

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  return (
    <>
      {/* `@container/bar` is what makes `top-bar-tiers.ts` a question about
          AVAILABLE width. The fragment and the `z-30` are its price, and both
          are deliberately paid whether or not this engine charges it.

          CSS Containment 3 says `container-type: inline-size` applies LAYOUT
          containment, and layout containment makes an element (a) the
          containing block for `position: fixed` / `absolute` descendants and
          (b) a stacking context. Both would matter here: the four dialogs
          below are `fixed inset-0` and would collapse into a 48px bar, and the
          info tooltip's and the ⋯ menu's `z-50` would be scoped inside a
          `z-auto` box that comes EARLIER in DOM order than `ChatNoticeStack`'s
          `absolute top-12 z-20` — so a notice card would paint over exactly the
          band they hang into.

          NEITHER READING IS RELIED ON, because no measurement can settle it
          here. Chromium 151 applies no containment for `container-type` (a
          `fixed inset-0` child still resolves to the viewport, and a `z-50`
          descendant still paints over a `z-20` sibling), but the app's Electron
          ships a different Chromium and an engine that reads the spec literally
          is conforming, not broken. `getComputedStyle().contain` cannot tell
          them apart either way: `contain` is a separate property, and
          containment implied by `container-type` is not written back into it.

          So: the dialogs sit OUTSIDE the container (hence the fragment; they
          were already `z-[100]` under a non-stacking `relative` parent, so
          their paint order is unchanged), and `z-30` makes the bar's own
          overlays win over the notice stack and the `z-10` widget stack in
          BOTH readings — a stacking context at z-30 beats a z-20 sibling just
          as a z-50 descendant of a non-context does — while staying below the
          mobile sidebar scrim's `z-40` and every `z-[100]` dialog. Both
          invariants are pinned by test, the second by a hit test run twice:
          once as this engine behaves, once with the containment forced on. */}
      <div
        style={{
          paddingLeft: leftPadding,
          paddingRight: isMobileCtx ? 8 : 13,
          paddingTop: isMobileCtx ? 'env(safe-area-inset-top)' : undefined
        }}
        data-testid="TopBar"
        className="@container/bar shrink-0 h-12 flex items-center justify-between [-webkit-app-region:drag] border-b border-border relative z-30"
      >
        {/* `flex-1`, so this group's width is the space the right cluster leaves
            rather than the width of its own contents. That makes it a DEFINITE
            size its children can be laid out against — which is what lets
            `AuthPill`'s slot take the remainder and answer "does the full label
            fit?" from available width (the sidebar moves it by ~276px at a
            constant window size) instead of a window breakpoint. */}
        <div data-testid="TopBar.leftGroup" className="flex flex-1 items-center min-w-0">
          {/* Mobile: always show hamburger + new session */}
          {isMobileCtx && (
            <div className="[-webkit-app-region:no-drag] flex items-center gap-1 mr-2">
              <button
                data-testid="TopBar.toggleSidebar"
                onClick={toggleSidebar}
                className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="Menu"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M3 12h18" />
                  <path d="M3 6h18" />
                  <path d="M3 18h18" />
                </svg>
              </button>
              <button
                data-testid="TopBar.newSession"
                onClick={showWelcome}
                className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="New session"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
                </svg>
              </button>
            </div>
          )}
          {/* Desktop: show sidebar toggle when collapsed */}
          {!isMobileCtx && sidebarCollapsed && (
            <div
              style={
                isMac
                  ? {
                      position: 'absolute',
                      left: 82 / uiFontScale,
                      top: 22 / uiFontScale,
                      transform: 'translateY(-50%)'
                    }
                  : { marginRight: 8 }
              }
              className="[-webkit-app-region:no-drag] flex items-center gap-1"
            >
              <button
                data-testid="TopBar.toggleSidebar"
                onClick={toggleSidebar}
                className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="Show sidebar"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                  <path d="M14 9l3 3-3 3" />
                </svg>
              </button>
              <button
                data-testid="TopBar.newSession"
                onClick={showWelcome}
                className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="New session"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
                </svg>
              </button>
            </div>
          )}
          {/* Title and pill are ONE unit (ADR-070 §4: the pill sits immediately
              after the title, and after the two icons when the sidebar is
              collapsed). It is a unit here because the title's reservation below
              is a percentage, so it needs a containing block that is exactly
              "what the icons left" — against the whole left group it would
              promise the pill room the icons had already taken. */}
          <div data-testid="TopBar.titleGroup" className="flex flex-1 items-center min-w-0">
            {/* The title shrinks; the 34px the pill needs is reserved by the
                pill's OWN slot (`AuthPillSlot`), so a healthy session — which is
                every session, nearly all of the time — spends none of it. As a
                `max-w` here it was charged unconditionally, which is precisely
                the permanent cost ADR-070 §4 promised the pill would not be. */}
            <div
              data-testid="TopBar.info"
              className="flex items-center min-w-0 [-webkit-app-region:no-drag] relative"
              onMouseEnter={infoMouseEnter}
              onMouseLeave={infoMouseLeave}
            >
              <span className="flex items-center gap-1 text-[13px] text-text-secondary font-normal truncate cursor-default">
                {cwd && hasContent && engineId && engineId !== 'claude' && (
                  <EngineLogo engineId={engineId} size={11} className="shrink-0 opacity-75" />
                )}
                {!cwd ? 'New session' : hasContent ? customTitle || 'Session' : 'New session'}
              </span>
              {(cwd || displaySessionId) && (
                <>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0 ml-1 text-text-muted/40 relative top-px"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  {infoHover && (
                    <div
                      className="absolute top-full left-0 pt-1 z-50"
                      onMouseEnter={infoMouseEnter}
                      onMouseLeave={infoMouseLeave}
                    >
                      <div className="bg-bg-primary border border-border rounded-lg shadow-lg py-2 px-3 space-y-2 min-w-[200px] max-w-[400px] animate-fade-in">
                        {cwd && (
                          <button
                            onClick={() => handleCopy(displayCwd(cwd), 'cwd')}
                            className="w-full text-left cursor-default group/row"
                          >
                            <div className="text-[10px] text-text-muted mb-0.5">
                              Working Directory
                            </div>
                            <div className="text-[11px] text-text-secondary font-mono truncate group-hover/row:text-text-primary transition-colors">
                              {copiedField === 'cwd' ? 'Copied!' : displayCwd(cwd)}
                            </div>
                          </button>
                        )}
                        {displaySessionId && (
                          <button
                            onClick={() => handleCopy(displaySessionId, 'sid')}
                            className="w-full text-left cursor-default group/row"
                          >
                            <div className="text-[10px] text-text-muted mb-0.5">Session ID</div>
                            <div className="text-[11px] text-text-secondary font-mono truncate group-hover/row:text-text-primary transition-colors">
                              {copiedField === 'sid' ? 'Copied!' : displaySessionId}
                            </div>
                          </button>
                        )}
                        {(showCost || sessionDurationMs > 0 || totalApiDurationMs > 0) && (
                          <div className="flex gap-4">
                            {showCost && (
                              <div>
                                <div className="text-[10px] text-text-muted mb-0.5">
                                  Cost
                                  {costCovered && (
                                    <span data-testid="TopBar.costCovered">
                                      {' '}
                                      · covered by subscription
                                    </span>
                                  )}
                                  {nothingBilled && (
                                    <span data-testid="TopBar.costNothingBilled">
                                      {' '}
                                      · nothing billed
                                    </span>
                                  )}
                                  {costFree && <span data-testid="TopBar.costFree"> · free</span>}
                                  {unpricedMessages > 0 && (
                                    <span data-testid="TopBar.costUnpriced">
                                      {' '}
                                      · {unpricedMessages} unpriced
                                    </span>
                                  )}
                                </div>
                                <div
                                  data-testid="TopBar.cost"
                                  className="text-[11px] text-text-secondary font-mono"
                                >
                                  {formatCostOrUnknown(cost)}
                                </div>
                                {showBilledCost && (
                                  <div
                                    data-testid="TopBar.billedCost"
                                    className="mt-0.5 pb-0.5 mb-0.5 flex items-center justify-between gap-3 border-b border-border/50"
                                  >
                                    <span className="text-[10px] text-text-muted">Billed</span>
                                    <span className="text-[10px] text-text-secondary font-mono shrink-0">
                                      {formatCostOrUnknown(billedCostUsd)}
                                    </span>
                                  </div>
                                )}
                                {showCostBreakdown && (
                                  <div
                                    data-testid="TopBar.costBreakdown"
                                    className="mt-1 space-y-0.5"
                                  >
                                    {sortedModelCosts.map((m) => (
                                      <div
                                        key={`${m.engineId}:${m.modelId}`}
                                        data-testid="TopBar.costBreakdownRow"
                                        data-model={m.modelId}
                                        {...(m.dispatched ? { 'data-dispatched': 'true' } : {})}
                                        className="flex items-center justify-between gap-3"
                                      >
                                        <span className="text-[10px] text-text-muted truncate">
                                          {m.dispatched
                                            ? `${dispatchedModelLabel(m.modelId)} · dispatched`
                                            : shortModelName(m.modelId)}
                                        </span>
                                        <span className="text-[10px] text-text-secondary font-mono shrink-0">
                                          {formatCostUsd(m.costUsd)}
                                        </span>
                                      </div>
                                    ))}
                                    {hasDispatchedCost && (
                                      <div
                                        data-testid="TopBar.costTotalInclDispatched"
                                        {...(costUnknown ? { 'data-cost-unknown': 'true' } : {})}
                                        className="flex items-center justify-between gap-3 pt-0.5 mt-0.5 border-t border-border/50"
                                      >
                                        <span className="text-[10px] text-text-muted truncate">
                                          Total incl. dispatched
                                        </span>
                                        <span className="text-[10px] text-text-secondary font-mono shrink-0">
                                          {costUnknown
                                            ? `${formatCostUsd(dispatchedCostUsd)} + ${COST_UNKNOWN}`
                                            : formatCostUsd(totalInclDispatchedUsd)}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                            {sessionDurationMs > 0 && (
                              <div data-testid="TopBar.sessionTime">
                                <div className="text-[10px] text-text-muted mb-0.5">
                                  Session time
                                </div>
                                <div className="text-[11px] text-text-secondary font-mono">
                                  {formatDuration(sessionDurationMs)}
                                </div>
                              </div>
                            )}
                            {totalApiDurationMs > 0 && (
                              <div data-testid="TopBar.apiTime">
                                <div className="text-[10px] text-text-muted mb-0.5">API time</div>
                                <div className="text-[11px] text-text-secondary font-mono">
                                  {formatDuration(totalApiDurationMs)}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {/* ADR-070 §4: the app's one auth indicator, in the LEFT group right
                after the title — not in the already-full right cluster, and never
                with the engine or model beside it (those stay in the composer).
                It renders nothing while every credential is healthy or
                unprobed, and its slot charges the title nothing while it does. */}
            <AuthPillSlot />
          </div>
        </div>
        <div
          data-testid="TopBar.rightGroup"
          className="flex items-center gap-3 [-webkit-app-region:no-drag]"
        >
          {/* The ONE shrinkable child of this cluster, and deliberately in no
              tier (ADR-070 residual 1, Slice F decision).

              It could not simply collapse WITH the VS Code button: below tier 2
              the button's click has moved into the ⋯ menu, so hiding the line
              too would turn a refused pop-up into silence — the user taps
              "Open in VS Code", the menu closes and nothing at all happens.
              Keeping it in the cluster instead costs nothing, because it is the
              one text node here: `min-w-0 shrink` + `truncate` let it give up
              every pixel it has before the bar overflows, with the full text on
              its own `title`. `!isMobileCtx` went with the device branch — the
              phone can now reach VS Code through the menu, so it can now get
              this failure too. */}
          {ideError && (
            <span
              data-testid="TopBar.openVSCodeError"
              title={ideError}
              className="min-w-0 shrink text-[11px] text-red-400 max-w-[220px] truncate"
            >
              {ideError}
            </span>
          )}
          {/* TIER 2 — the five tools, each rendered from the ONE descriptor
              above, so a bar button and its ⋯ row cannot disagree about a gate,
              a label or a mark. The width rule alone decides which of the two
              surfaces the user sees; `!isMobileCtx` went with the device branch
              it belonged to. */}
          {barControls.map((control) => (
            <button
              key={control.id}
              data-testid={control.bar.testId}
              onClick={control.onSelect}
              title={control.keyHint ? `${control.label} ${control.keyHint}` : control.label}
              className={`${control.tier === 1 ? TIER1_HIDE : TIER2_HIDE} flex gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default ${control.bar.className ?? 'items-center'}`}
            >
              {control.bar.content}
            </button>
          ))}
          {/* TIER 1 — the first 344px the bar gives back. Both pills are
              ACTIONS, not inert state: `GitBranchPill` opens the app's only
              fetch / pull / push / switch dropdown and `WorktreePill` copies a
              path — which is why each has a ⋯ row above, and why the ⋯ button
              now arrives with this tier rather than waiting for tier 2 (owner
              ruling, 2026-09-19: 768–1000 could otherwise reach none of them).
              `contents` rather than a wrapper box, because both pills render
              null outside a repo / worktree and a wrapper would leave an empty
              flex item behind, paying the cluster's 12px gap for nothing. */}
          <div className={`contents ${TIER1_HIDE}`}>
            <WorktreePill />
          </div>
          <div className={`contents ${TIER1_HIDE}`}>
            <GitBranchPill />
          </div>
          {/* Never dropped: the changes pill doubles as the git-panel entry
              point (MobileGitView) and self-hides outside a git repo. */}
          <GitChangesPill />
          {/* The popovers below deliberately have no positioned wrapper: they
              anchor to the TopBar itself (the nearest positioned ancestor), so
              they hang below the whole bar right-aligned instead of mid-bar off
              the button.

              WHEN THE BUTTON EXISTS is a JS question — whether this session has
              any row to offer — and WHEN IT SHOWS is a CSS one: the complement
              of whichever tier those rows come from. Outside a repo tier 1 hides
              nothing, so the button would otherwise open an empty popover
              through the whole 768–1000 band. Every row is in the DOM at every
              width; CSS, not JS, picks the surface, because the bar has no
              measurement of its own and must not grow one. */}
          {controls.length > 0 && (
            <div
              ref={overflowRef}
              className={hasTier1Rows ? OVERFLOW_FROM_TIER1 : OVERFLOW_FROM_TIER2}
            >
              <button
                ref={overflowButtonRef}
                data-testid="TopBar.overflowMenu"
                onClick={() => setOverflowOpen((o) => !o)}
                className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="More"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="12" cy="19" r="1.6" />
                </svg>
              </button>
              {overflowOpen && (
                <div className="absolute top-full right-0 mt-1 z-50 min-w-[180px] max-w-[280px] bg-bg-primary border border-border rounded-lg shadow-lg py-1 animate-fade-in">
                  {controls.map((control) => (
                    <button
                      key={control.id}
                      data-testid={control.menuTestId}
                      onClick={() => {
                        setOverflowOpen(false)
                        control.onSelect()
                      }}
                      className={`${control.tier === 1 ? TIER1_ROW_HIDE : TIER2_ROW_HIDE} w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] text-text-secondary hover:bg-bg-hover transition-colors`}
                    >
                      {control.menuIcon}
                      <span className="truncate">{control.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* The pills' OWN panels, opened from the rows that stand in for
                  them — not a second copy, so a fix to either reaches both
                  surfaces. `align="right"` is the only difference: hung off the
                  ⋯ they follow the menu to the bar's right edge. */}
              {gitPopover === 'branch' && (
                <GitBranchDropdown
                  onClose={() => setGitPopover(null)}
                  anchorRef={overflowButtonRef}
                />
              )}
              {gitPopover === 'worktree' && (
                <WorktreePopover
                  align="right"
                  anchorRef={overflowButtonRef}
                  onClose={() => setGitPopover(null)}
                />
              )}
            </div>
          )}
          {/* Never dropped either, and no longer device-gated: `WindowControls`
              renders only on win32, where it is the frameless window's ONLY
              minimise / maximise / close. The old `!isMobileCtx` took them away
              from a narrow Electron window — `minWidth: 600` is well inside the
              mobile breakpoint — leaving no way to close the app from the bar. */}
          <WindowControls />
        </div>
      </div>
      <SkillsDialog open={skillsOpen} onClose={() => setSkillsOpen(false)} cwd={cwd} />
      <McpDialog
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        cwd={cwd}
        routingId={activeSessionId}
      />
      <PermissionsDialog
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
        cwd={cwd}
      />
      {ideDialog && (
        <IdeUnavailableDialog
          reason={ideDialog.reason}
          {...(ideDialog.detail ? { detail: ideDialog.detail } : {})}
          onClose={() => setIdeDialog(null)}
        />
      )}
    </>
  )
}
