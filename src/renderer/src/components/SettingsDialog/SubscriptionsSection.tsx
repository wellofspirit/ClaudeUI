/**
 * SubscriptionsSection — Models & providers › SUBSCRIPTIONS (ADR-074 §7,
 * mockup `829a066c`).
 *
 * One block per sign-in subscription (`ProviderEntry.subscription`), in registry
 * order, each in three zones: the HEADER says what it is and whether it is
 * healthy, the ACCOUNT LIST says who you are signed in as, and the ENGINES row
 * says who gets it — the same pills an API provider row carries, with Manage
 * opening the same sheet (minus its Credential group: the accounts here ARE the
 * credential). Options are folded, because they are set once.
 *
 * NOTHING THAT MOVES A CREDENTIAL HAPPENS WITHOUT A CONFIRM, and the confirm
 * says what it does, counted: "Set active", Remove, and turning Multiple
 * accounts on or off all re-point live sessions. Each provider has its own rule
 * — Claude cancels every live Claude session whenever the credential directory
 * moves (`invalidateLiveSessions`, ADR-015); a Codex session that follows the
 * active account leaves its host while one PINNED to an account keeps it
 * (ADR-069 §4); pi and opencode read the vended credential when they start.
 *
 * MOVED, NOT REWRITTEN. The writes are the ones `AccountsSetting` and
 * `ChatgptAccountsSetting` made — `account:*` for Claude's file-based accounts,
 * `provider-account:*` for the vault's — and every write is followed by a
 * registry re-read, because the registry publishes no change event.
 *
 * THE HONEST UNKNOWN. A registry that has not answered renders a loading row,
 * and an Anthropic sign-in nothing has checked yet says so: claiming "Not
 * signed in" before anything was read would put a sign-in button in front of a
 * signed-in user (ADR-030).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import claudeLogo from '../../assets/logos/claude-color.svg'
import codexLogo from '../../assets/logos/codex-color.svg'
import { useSessionStore } from '../../stores/session-store'
import type { PerSessionState } from '../../stores/session-store'
import { engineMeta } from '../../../../shared/engine-meta'
import type { ProviderEntry } from '../../../../shared/provider-registry'
import type { AccountsState, EngineId } from '../../../../shared/types'
import { accountDisplayName } from '../../utils/sign-in-provider'
import { Button, SettingRow, ToggleSwitch } from './settings-controls'
import { ProviderSheet } from './ProviderSheet'
import {
  curationCount,
  opencodeCurationAdapter,
  piCurationAdapter,
  summariseSelection,
  type CuratedEngine,
  type CurationSummary
} from './ModelCuration'

/** Testid namespace (ADR-027 tier 1/2): the component's own name. */
const SUBS = 'SubscriptionsSection'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── Pure wording (exported for tests) ────────────────────────────────────────

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** The live sessions a credential change touches, counted from the store. */
export interface LiveSessionCounts {
  claude: number
  /** Live Codex sessions that follow the active account. */
  codexFollowing: number
  /** Live Codex sessions pinned to one account — a switch leaves them alone. */
  codexPinned: number
}

export function countLiveSessions(sessions: Record<string, PerSessionState>): LiveSessionCounts {
  const counts: LiveSessionCounts = { claude: 0, codexFollowing: 0, codexPinned: 0 }
  for (const session of Object.values(sessions)) {
    // A session with no live process has nothing to disconnect.
    if (!session.sdkActive) continue
    if (session.selectedEngineId === 'claude') counts.claude++
    else if (session.selectedEngineId === 'codex') {
      if (session.status.codex?.pinnedAccountId) counts.codexPinned++
      else counts.codexFollowing++
    }
  }
  return counts
}

/** What moving Claude's credential does to live sessions, in one sentence. */
export function claudeSwitchConsequence(live: number): string {
  if (live === 0) return 'No running Claude session is affected.'
  return `${live} running Claude ${plural(live, 'session disconnects', 'sessions disconnect')} and ${plural(live, 'resumes on its', 'resume on their')} next message.`
}

/**
 * What switching the ACTIVE ChatGPT account does: the Codex followers it
 * disconnects, the enabled routes that pick it up, and the pinned sessions it
 * leaves alone.
 *
 * A pin belongs to the SESSION (each Codex session decides for itself whether
 * it follows — `followCodexActiveAccount`), so pinned sessions are counted
 * whether or not per-session pinning is on right now: turning the option off
 * stops new pins, it does not unpin a running session.
 *
 * pi and opencode are said to pick it up on START, not immediately: the switch
 * re-feeds both engines' auth files, but a running opencode server keeps the
 * credential it loaded (`OpencodeAuthProvider`'s feed does not recycle).
 */
export function chatgptSwitchConsequence(
  counts: Pick<LiveSessionCounts, 'codexFollowing' | 'codexPinned'>,
  routes: readonly EngineId[]
): string {
  const n = counts.codexFollowing
  const parts = [
    n === 0
      ? 'No running Codex session that follows the active account is affected.'
      : `${n} running Codex ${plural(n, 'session', 'sessions')} that ${plural(n, 'follows', 'follow')} the active account ${plural(n, 'disconnects and resumes on its', 'disconnect and resume on their')} next message.`
  ]
  if (routes.length > 0) {
    const names = routes.map((engine) => engineMeta(engine).label)
    parts.push(`New ${names.join(' and ')} sessions use it too.`)
  }
  if (counts.codexPinned > 0) {
    const p = counts.codexPinned
    parts.push(
      `${p} pinned Codex ${plural(p, 'session keeps its', 'sessions keep their')} account.`
    )
  }
  return parts.join(' ')
}

/**
 * What removing an account does. Removing a non-active one changes nothing
 * running. Removing the ACTIVE one is a switch — to `successor` when one is
 * left, or to the provider's fallback when it was the last — so it carries the
 * same live-session sentence as Set active.
 */
export function removeConsequence(opts: {
  active: boolean
  /** Who becomes active instead, when another account is left. */
  successor?: string
  /** What happens when the removed account was the LAST one. */
  lastAccount?: string
  /** The live-session sentence, for an active removal. */
  sessions?: string
}): string {
  const parts = ['Its stored sign-in is deleted.']
  if (opts.active) {
    if (opts.successor) parts.push(`${opts.successor} becomes the active account.`)
    else if (opts.lastAccount) parts.push(opts.lastAccount)
    if (opts.sessions) parts.push(opts.sessions)
  }
  parts.push('You can add it back by signing in.')
  return parts.join(' ')
}

// ── Atoms ────────────────────────────────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'plain'

function Pill({
  tone = 'plain',
  testid,
  dataId,
  children
}: {
  tone?: Tone
  testid?: string
  dataId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const look =
    tone === 'ok'
      ? 'border-success/30 bg-success/5 text-success'
      : tone === 'warn'
        ? 'border-warning/30 bg-warning/5 text-warning'
        : 'border-border text-text-secondary'
  return (
    <span
      data-testid={testid}
      data-id={dataId}
      data-tone={tone}
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2 text-[11px] leading-[18px] whitespace-nowrap ${look}`}
    >
      {tone !== 'plain' && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** A stable colour per account, so one person's avatar does not change between renders. */
const AVATAR_COLORS = ['#d97757', '#a78bfa', '#4ade80', '#6c9eff', '#f472b6', '#fbbf24']
function avatarColor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function Avatar({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{ background: avatarColor(name) }}
      className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold text-bg-primary"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/** Decorative: the provider's NAME is right beside it, so the image says nothing more. */
function Logo({ provider }: { provider: 'anthropic' | 'chatgpt' }): React.JSX.Element {
  return provider === 'anthropic' ? (
    <span
      data-testid={`${SUBS}.logo`}
      data-id="claude"
      className="w-[34px] h-[34px] shrink-0 rounded-[9px] flex items-center justify-center bg-[#d97757]/10 border border-[#d97757]/20"
    >
      <img src={claudeLogo} width={20} height={20} alt="" />
    </span>
  ) : (
    <span
      data-testid={`${SUBS}.logo`}
      data-id="codex"
      className="w-[34px] h-[34px] shrink-0 rounded-[9px] overflow-hidden flex items-center justify-center"
    >
      <img src={codexLogo} width={34} height={34} alt="" />
    </span>
  )
}

/** The plaintext-credentials warning, where the option that causes it is. */
function PlaintextNotice({ isMac }: { isMac: boolean }): React.JSX.Element {
  return (
    <span
      data-testid={`${SUBS}.plaintextNotice`}
      className="mt-2 block border-l-2 border-warning bg-warning/5 rounded-r-lg px-3 py-2 text-[12px] text-text-secondary"
    >
      <span className="text-warning">Stored as plaintext files</span> under{' '}
      <span className="font-mono text-[11px]">~/.claude/ui/accounts</span>
      {isMac ? ', not the macOS Keychain' : ''}.
    </span>
  )
}

/**
 * An inline confirm. It takes focus (its primary button) when it opens, and
 * gives it back on Cancel to whatever opened it — or, when that is gone (a menu
 * item), to the row's `fallbackFocus`.
 */
function InlineConfirm({
  dataId,
  danger = false,
  title,
  children,
  primaryLabel,
  primaryTestid,
  busy,
  onConfirm,
  onCancel,
  fallbackFocus,
  inset = true
}: {
  dataId: string
  danger?: boolean
  title: React.ReactNode
  children: React.ReactNode
  primaryLabel: string
  primaryTestid: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  fallbackFocus?: React.RefObject<HTMLElement | null>
  /** Indented under an account row's avatar; off for a card-level confirm. */
  inset?: boolean
}): React.JSX.Element {
  const primary = useRef<HTMLSpanElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    opener.current = document.activeElement
    primary.current?.querySelector('button')?.focus()
  }, [])
  const cancel = (): void => {
    onCancel()
    const back =
      opener.current instanceof HTMLElement && opener.current.isConnected
        ? opener.current
        : fallbackFocus?.current
    back?.focus()
  }
  return (
    <div
      role="group"
      aria-label="Confirm"
      data-testid={`${SUBS}.confirm`}
      data-id={dataId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          cancel()
        }
      }}
      className={`${inset ? 'mx-3.5 mb-2 ml-[53px]' : 'mx-4 mb-3'} rounded-[9px] border px-3 py-2.5 bg-bg-tertiary ${
        danger ? 'border-danger/35' : 'border-border'
      }`}
    >
      <div className="text-[13px] text-text-primary">{title}</div>
      <div data-testid={`${SUBS}.consequence`} className="mt-0.5 text-[12px] text-text-secondary">
        {children}
      </div>
      <div className="mt-2.5 flex gap-2">
        <span ref={primary} className="contents">
          <Button
            variant={danger ? 'danger' : 'primary'}
            testid={primaryTestid}
            disabled={busy}
            onClick={onConfirm}
          >
            {primaryLabel}
          </Button>
        </span>
        <Button variant="link" testid={`${SUBS}.cancel`} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ── The ⋯ menu ───────────────────────────────────────────────────────────────

interface MenuAction {
  id: string
  label: string
  danger?: boolean
  onSelect: () => void
}

/**
 * The row's action menu: focus moves into it on open, the arrows move within
 * it, Escape and an outside click close it, and focus returns to the trigger.
 * Which menu is open is the SECTION's state, so only one is ever open.
 */
function AccountMenu({
  accountId,
  actions,
  open,
  onOpenChange
}: {
  accountId: string
  actions: MenuAction[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLSpanElement>(null)
  const menuId = useId()

  const items = (): HTMLElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open, onOpenChange])

  if (actions.length === 0) return null

  const close = (refocus: boolean): void => {
    onOpenChange(false)
    if (refocus) trigger.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      list[(at + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <span className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={`${SUBS}.more`}
        data-id={accountId}
        onClick={() => onOpenChange(!open)}
        className="h-[26px] px-2 rounded-md text-text-secondary hover:bg-bg-hover cursor-default"
      >
        ⋯
      </button>
      {open && (
        <span
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Account actions"
          data-testid={`${SUBS}.menu`}
          onKeyDown={onKeyDown}
          className="absolute right-0 top-8 z-10 min-w-[170px] flex flex-col p-1 rounded-lg border border-border bg-bg-tertiary shadow-xl"
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid={`${SUBS}.menuItem`}
              data-id={action.id}
              onClick={() => {
                close(false)
                action.onSelect()
              }}
              className={`text-left px-2.5 py-1.5 rounded-md text-[12px] hover:bg-bg-hover focus:bg-bg-hover outline-none cursor-default ${
                action.danger ? 'text-danger' : 'text-text-primary'
              }`}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

// ── One account row ──────────────────────────────────────────────────────────

interface AccountRowModel {
  id: string
  email: string
  plan?: string
  /** ChatGPT only: the organisation the account belongs to. */
  workspace?: string
  active: boolean
  needsReauth?: boolean
  /** The single signed-in identity with Multiple accounts off: nothing to switch or remove. */
  fixed?: boolean
}

type Pending = { kind: 'activate' | 'remove'; id: string } | null

function AccountRow({
  account,
  busy,
  pending,
  menuOpen,
  onMenuOpenChange,
  activateSentence,
  removeSentence,
  onPending,
  onActivate,
  onRemove,
  onReauth
}: {
  account: AccountRowModel
  busy: boolean
  pending: Pending
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  /** The switch sentence, computed by the card that knows its provider's rule. */
  activateSentence: string
  removeSentence: string
  onPending: (next: Pending) => void
  onActivate: () => void
  onRemove: () => void
  /** Sign this account in again. The row passes no id — the card decides whether to blame one. */
  onReauth: () => void
}): React.JSX.Element {
  const confirming = pending?.id === account.id ? pending.kind : null
  const rowRef = useRef<HTMLDivElement>(null)
  const copyWorkspace = (): void => {
    if (account.workspace) void navigator.clipboard?.writeText(account.workspace).catch(() => {})
  }

  // "Sign in again" is offered where it means something: on the account that
  // is in use, or on one whose sign-in the vault has given up on. On any other
  // row it would open the dialog BLAMING a healthy account, and that dialog's
  // own switch would skip the confirm above.
  const actions: MenuAction[] = account.fixed
    ? []
    : [
        ...(!account.active
          ? [
              {
                id: 'activate',
                label: 'Set as active',
                onSelect: () => onPending({ kind: 'activate', id: account.id })
              }
            ]
          : []),
        ...(account.active || account.needsReauth
          ? [{ id: 'reauth', label: 'Sign in again', onSelect: onReauth }]
          : []),
        ...(account.workspace
          ? [{ id: 'copy', label: 'Copy workspace id', onSelect: copyWorkspace }]
          : []),
        {
          id: 'remove',
          label: 'Remove account…',
          danger: true,
          onSelect: () => onPending({ kind: 'remove', id: account.id })
        }
      ]

  return (
    <div
      ref={rowRef}
      data-testid={`${SUBS}.account`}
      data-id={account.id}
      data-active={account.active}
    >
      <div
        className={`relative flex items-center gap-[11px] px-3.5 py-[9px] rounded-[9px] ${
          account.needsReauth
            ? 'bg-warning/5'
            : account.active
              ? 'bg-accent/5'
              : 'hover:bg-bg-hover/40'
        }`}
      >
        <Avatar name={account.email} />
        <span className="flex-1 min-w-0">
          <span
            className={`block truncate text-[13px] leading-[18px] ${
              account.active ? 'text-text-primary font-medium' : 'text-text-primary'
            }`}
          >
            {account.email}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
            {account.plan && <Pill testid={`${SUBS}.plan`}>{account.plan}</Pill>}
            {account.workspace && (
              <span data-testid={`${SUBS}.workspace`} className="inline-flex items-center gap-1">
                <span
                  title="The ChatGPT organisation this account belongs to — not a directory."
                  className="border-b border-dotted border-text-muted cursor-help"
                >
                  workspace
                </span>
                <span className="font-mono text-[11px]">{account.workspace.slice(0, 8)}…</span>
                <Button
                  variant="link"
                  testid={`${SUBS}.copyWorkspace`}
                  dataId={account.id}
                  onClick={copyWorkspace}
                >
                  copy
                </Button>
              </span>
            )}
          </span>
        </span>

        {account.needsReauth ? (
          <>
            <Pill tone="warn" testid={`${SUBS}.status`} dataId="signed-out">
              Signed out
            </Pill>
            <Button
              variant="primary"
              testid={`${SUBS}.reauth`}
              dataId={account.id}
              disabled={busy}
              onClick={onReauth}
            >
              Sign in again
            </Button>
          </>
        ) : account.active ? (
          <>
            <Pill tone="ok" testid={`${SUBS}.status`} dataId="active">
              Active
            </Pill>
            {account.fixed && (
              <Button
                variant="link"
                testid={`${SUBS}.reauth`}
                dataId={account.id}
                disabled={busy}
                onClick={onReauth}
              >
                Sign in again
              </Button>
            )}
          </>
        ) : (
          <Button
            variant="tinted"
            testid={`${SUBS}.setActive`}
            dataId={account.id}
            disabled={busy}
            onClick={() => onPending({ kind: 'activate', id: account.id })}
          >
            Set active
          </Button>
        )}

        <AccountMenu
          accountId={account.id}
          actions={actions}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
        />
      </div>

      {confirming && (
        <InlineConfirm
          dataId={confirming}
          danger={confirming === 'remove'}
          title={
            confirming === 'activate' ? (
              <>
                Set <b>{account.email}</b> as the active account?
              </>
            ) : (
              <>
                Remove <b>{account.email}</b>?
              </>
            )
          }
          primaryLabel={confirming === 'activate' ? 'Set active' : 'Remove'}
          primaryTestid={
            confirming === 'activate' ? `${SUBS}.confirmActivate` : `${SUBS}.confirmRemove`
          }
          busy={busy}
          onConfirm={confirming === 'activate' ? onActivate : onRemove}
          onCancel={() => onPending(null)}
          fallbackFocus={rowRef}
        >
          {confirming === 'activate' ? activateSentence : removeSentence}
        </InlineConfirm>
      )}
    </div>
  )
}

// ── Card chrome ──────────────────────────────────────────────────────────────

function CardHeader({
  provider,
  name,
  subtitle,
  accounts,
  status
}: {
  provider: 'anthropic' | 'chatgpt'
  name: string
  subtitle: string
  accounts: number
  status: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 pt-4 pb-2">
      <Logo provider={provider} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-text-primary">{name}</span>
          {accounts > 1 && (
            <span data-testid={`${SUBS}.accountCount`} className="text-[12px] text-text-secondary">
              · {accounts} accounts
            </span>
          )}
        </span>
        <span className="block text-[12px] text-text-secondary">{subtitle}</span>
      </span>
      {status}
    </div>
  )
}

function EnginesRow({
  children,
  trailing
}: {
  children: React.ReactNode
  trailing: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid={`${SUBS}.engines`}
      className="flex items-center gap-3 mx-4 mb-3 px-3 py-2.5 rounded-[10px] border border-border bg-bg-primary/40"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Engines
      </span>
      <span className="flex-1 min-w-0 flex flex-wrap gap-1.5">{children}</span>
      {trailing}
    </div>
  )
}

/** One engine pill: accent when it gets the subscription, dim "off" when not. */
function EnginePill({
  engine,
  count,
  on,
  warn = false
}: {
  engine: EngineId
  count?: string
  on: boolean
  warn?: boolean
}): React.JSX.Element {
  return (
    <span
      data-testid={`${SUBS}.enginePill`}
      data-id={engine}
      data-on={on}
      className={`inline-flex items-center gap-1 rounded-full border px-2 text-[11px] leading-[18px] whitespace-nowrap ${
        !on
          ? 'border-border text-text-muted opacity-60'
          : warn
            ? 'border-warning/30 bg-warning/5 text-warning'
            : 'border-accent/30 bg-accent/5 text-accent'
      }`}
    >
      {engineMeta(engine).label}
      {(count ?? (!on ? 'off' : undefined)) && (
        <span className="font-mono">{on ? count : 'off'}</span>
      )}
    </span>
  )
}

/** A controlled `<details>`: opening it programmatically shows the notice an action caused. */
function OptionsFold({
  id,
  open,
  onOpenChange,
  summary,
  children
}: {
  id: string
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
      data-testid={`${SUBS}.options`}
      data-id={id}
      className="border-t border-border/55 group/opt"
    >
      <summary
        data-testid={`${SUBS}.optionsSummary`}
        className="flex items-center gap-2 px-4 py-2.5 text-[12px] text-text-secondary hover:bg-bg-hover/40 cursor-default list-none [&::-webkit-details-marker]:hidden"
      >
        <span
          aria-hidden="true"
          className="inline-block transition-transform group-open/opt:rotate-90"
        >
          ›
        </span>
        <span>Options</span>
        <span className="text-text-muted">·</span>
        <span>{summary}</span>
      </summary>
      <div className="px-4 pb-2">{children}</div>
    </details>
  )
}

function OptionRow({
  testid,
  toggleTestid,
  label,
  description,
  checked,
  disabled,
  onToggle,
  children
}: {
  testid: string
  toggleTestid: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div data-testid={testid} className="flex items-start gap-3.5 py-3">
      <span className="flex-1 min-w-0">
        <span id={labelId} className="block text-[13px] text-text-primary">
          {label}
        </span>
        <span id={descriptionId} className="block text-[12px] text-text-secondary">
          {description}
        </span>
        {children}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        data-testid={toggleTestid}
        disabled={disabled}
        onClick={onToggle}
        className="cursor-default disabled:opacity-40"
      >
        <ToggleSwitch checked={checked} />
      </button>
    </div>
  )
}

/**
 * The shared per-card write runner: one error slot, busy while a write is in
 * flight. Resolves `true` when the write landed, so a caller can chain the next
 * step (a sign-in) only on success.
 */
function useWriter(): {
  busy: boolean
  error: string | null
  run: (action: () => Promise<unknown>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await useSessionStore.getState().refreshProviderAuth()
      return true
    } catch (e) {
      setError(message(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run }
}

function CardError({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <div data-testid={`${SUBS}.error`} role="alert" className="px-4 pb-2 text-[12px] text-danger">
      {error}
    </div>
  )
}

/** Live-session counts as a primitive, so the store selector is stable. */
function useLiveSessionCounts(): LiveSessionCounts {
  const key = useSessionStore((s) => {
    const c = countLiveSessions(s.sessions)
    return `${c.claude}|${c.codexFollowing}|${c.codexPinned}`
  })
  const [claude, codexFollowing, codexPinned] = key.split('|').map(Number)
  return { claude, codexFollowing, codexPinned }
}

/** Which ⋯ menu is open, section-wide — `<card>:<account>`, or none. */
interface MenuControl {
  openMenu: string | null
  setOpenMenu: (key: string | null) => void
}

function menuProps(
  control: MenuControl,
  card: string,
  account: string
): { menuOpen: boolean; onMenuOpenChange: (open: boolean) => void } {
  const key = `${card}:${account}`
  return {
    menuOpen: control.openMenu === key,
    onMenuOpenChange: (open) => control.setOpenMenu(open ? key : null)
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

/** Turning Multiple accounts on or off, and where the confirm was opened from. */
type MultiConfirm = { to: boolean; from: 'add' | 'option' } | null

function AnthropicCard({
  entry,
  menus
}: {
  entry: ProviderEntry
  menus: MenuControl
}): React.JSX.Element {
  const accounts = useSessionStore((s) => s.accountsState)
  const setAccounts = useSessionStore((s) => s.setAccountsState)
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const live = useLiveSessionCounts()
  const { busy, error, run } = useWriter()
  const [pending, setPending] = useState<Pending>(null)
  const [multiConfirm, setMultiConfirm] = useState<MultiConfirm>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)

  useEffect(() => {
    void window.api
      .getAccounts()
      .then(setAccounts)
      .catch(() => {})
  }, [setAccounts])

  const multi = accounts?.enabled ?? false
  const isMac = window.api.platform === 'darwin'
  const fallbackSignIn = isMac ? 'the macOS Keychain sign-in' : 'Claude’s own sign-in'
  /** Claude's `account:*` writes answer with the new state; keep it, then re-read. */
  const write = (action: () => Promise<AccountsState>): Promise<boolean> =>
    run(async () => setAccounts(await action()))

  const signIn = (): void => openSignIn({ providerId: 'anthropic', mode: 'reauth' })

  const list = multi ? (accounts?.accounts ?? []) : []
  const rows: AccountRowModel[] = multi
    ? list.map((account) => ({
        id: account.id,
        email: accountDisplayName(account.email),
        ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
        active: account.id === accounts?.activeId
      }))
    : entry.credential === 'signed-in'
      ? [
          {
            id: 'signed-in',
            email: entry.identity?.label ?? 'Signed in',
            ...(entry.identity?.plan ? { plan: entry.identity.plan } : {}),
            active: true,
            fixed: true
          }
        ]
      : []

  /**
   * Claude promotes the FIRST remaining account when the active one goes
   * (`AccountManager.deleteAccount`), and with none left falls back to the
   * sign-in outside ClaudeUI — the credential directory moves either way.
   */
  const removeSentence = (id: string): string => {
    const successor = list.find((candidate) => candidate.id !== id)
    return removeConsequence({
      active: id === accounts?.activeId,
      ...(successor ? { successor: accountDisplayName(successor.email) } : {}),
      lastAccount: `Claude goes back to ${fallbackSignIn}.`,
      sessions: claudeSwitchConsequence(live.claude)
    })
  }

  const confirmMulti = async (to: boolean): Promise<void> => {
    setMultiConfirm(null)
    const ok = await write(() => window.api.setMultiAccountEnabled(to))
    // Turning it on seeds an EMPTY account and points Claude at it, so the
    // next thing is to sign that account in — the active one, hence `reauth`
    // (an `add` would create a second, leaving this one empty).
    if (ok && to) signIn()
  }

  const multiConfirmBlock = (from: 'add' | 'option'): React.ReactNode =>
    multiConfirm && multiConfirm.from === from ? (
      <InlineConfirm
        dataId={multiConfirm.to ? 'multi-on' : 'multi-off'}
        title={multiConfirm.to ? 'Turn on Multiple accounts?' : 'Turn off Multiple accounts?'}
        primaryLabel={multiConfirm.to ? 'Turn on and sign in' : 'Turn off'}
        primaryTestid={`${SUBS}.confirmMulti`}
        inset={false}
        busy={busy}
        onConfirm={() => void confirmMulti(multiConfirm.to)}
        onCancel={() => setMultiConfirm(null)}
      >
        {multiConfirm.to ? (
          <>
            {claudeSwitchConsequence(live.claude)} You’ll sign in again for this account.
            <PlaintextNotice isMac={isMac} />
          </>
        ) : (
          <>
            Claude goes back to {fallbackSignIn}; the stored accounts stay, unused, until you turn
            this on again. {claudeSwitchConsequence(live.claude)}
          </>
        )}
      </InlineConfirm>
    ) : null

  const status = entry.signInUnknown ? (
    <Pill testid={`${SUBS}.cardStatus`} dataId="unknown">
      Not checked yet
    </Pill>
  ) : entry.credential === 'signed-in' ? (
    <Pill tone="ok" testid={`${SUBS}.cardStatus`} dataId="signed-in">
      Signed in
    </Pill>
  ) : (
    <Pill testid={`${SUBS}.cardStatus`} dataId="none">
      Not signed in
    </Pill>
  )

  return (
    <div data-testid={`${SUBS}.card`} data-id={entry.id}>
      <CardHeader
        provider="anthropic"
        name={entry.name}
        subtitle="Claude subscription"
        accounts={rows.length}
        status={status}
      />
      <CardError error={error} />

      {rows.length === 0 &&
        (entry.signInUnknown ? (
          <div
            data-testid={`${SUBS}.unknown`}
            className="px-4 pb-3 text-[12px] text-text-secondary"
          >
            Sign-in status is checked when the first Claude session starts.
          </div>
        ) : (
          <div className="px-4 pb-3">
            <div
              data-testid={`${SUBS}.signInCta`}
              data-id={entry.id}
              className="flex items-center gap-3 p-4 rounded-[10px] border border-border bg-bg-tertiary"
            >
              <span className="flex-1 text-[12px] text-text-secondary">
                Every Claude session runs as the account you sign in with.
              </span>
              <Button
                variant="primary"
                testid={`${SUBS}.signIn`}
                dataId={entry.id}
                onClick={signIn}
              >
                Sign in to Claude
              </Button>
            </div>
          </div>
        ))}

      <div className="px-1.5 pb-1">
        {rows.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            busy={busy}
            pending={pending}
            {...menuProps(menus, entry.id, account.id)}
            activateSentence={claudeSwitchConsequence(live.claude)}
            removeSentence={removeSentence(account.id)}
            onPending={setPending}
            onActivate={() => {
              setPending(null)
              void write(() => window.api.switchAccount(account.id))
            }}
            onRemove={() => {
              setPending(null)
              void write(() => window.api.deleteAccount(account.id))
            }}
            // Claude keeps no per-account "signed out" flag, so nothing is blamed.
            onReauth={signIn}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3">
        {multi ? (
          <Button
            variant="link"
            testid={`${SUBS}.addAccount`}
            dataId={entry.id}
            disabled={busy}
            onClick={() => openSignIn({ providerId: 'anthropic', mode: 'add' })}
          >
            + Add account
          </Button>
        ) : (
          <>
            {/* Shown rather than hidden, so the feature can be found — but
                adding a second account IS turning Multiple accounts on, which
                moves Claude's credential, so it confirms first. */}
            <Button
              variant="link"
              testid={`${SUBS}.addAccount`}
              dataId={entry.id}
              disabled={busy}
              onClick={() => setMultiConfirm({ to: true, from: 'add' })}
            >
              + Add account
            </Button>
            <span className="text-[12px] text-text-secondary">turns on Multiple accounts</span>
          </>
        )}
      </div>
      {multiConfirmBlock('add')}

      <EnginesRow trailing={<span className="text-[12px] text-text-secondary">Always on</span>}>
        <EnginePill engine="claude" on />
      </EnginesRow>

      <OptionsFold
        id={entry.id}
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        summary={
          multi
            ? 'Multiple accounts on'
            : isMac
              ? 'Single account (macOS Keychain)'
              : 'Single account'
        }
      >
        <OptionRow
          testid={`${SUBS}.multiAccount`}
          toggleTestid={`${SUBS}.multiAccountToggle`}
          label="Multiple accounts"
          description="Keep several Claude subscriptions and switch between them."
          checked={multi}
          disabled={busy}
          onToggle={() => setMultiConfirm({ to: !multi, from: 'option' })}
        >
          {/* The warning sits on the option that causes it, and only while it is on. */}
          {multi && <PlaintextNotice isMac={isMac} />}
        </OptionRow>
        {multiConfirmBlock('option')}
      </OptionsFold>
    </div>
  )
}

// ── ChatGPT ──────────────────────────────────────────────────────────────────

/**
 * The count an engine pill carries — the Manage sheet's own curation count
 * (`n of m` / `all m`). Re-read on each model reload, except while `paused`
 * (the Manage sheet is open and every edit bumps the reload counter): then it
 * reads once, when the sheet closes.
 */
function useCurationSummary(
  engine: CuratedEngine,
  providerId: string | undefined,
  on: boolean,
  paused: boolean
): CurationSummary | null {
  const nonce = useSessionStore((s) => s.modelReloadNonce)
  const [summary, setSummary] = useState<CurationSummary | null>(null)
  useEffect(() => {
    if (paused) return
    if (!on || !providerId) {
      setSummary(null)
      return
    }
    let cancelled = false
    const adapter =
      engine === 'opencode' ? opencodeCurationAdapter(providerId) : piCurationAdapter(providerId)
    void Promise.all([adapter.loadCatalog(), adapter.loadSelection()])
      .then(([catalog, selection]) => {
        if (!cancelled) setSummary(summariseSelection(catalog, selection))
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [engine, providerId, on, nonce, paused])
  return summary
}

function ChatgptCard({
  entry,
  opencodeInstalled,
  managing,
  menus,
  onManage
}: {
  entry: ProviderEntry
  opencodeInstalled: boolean
  /** Its Manage sheet is open — the pill counts wait until it closes. */
  managing: boolean
  menus: MenuControl
  onManage: () => void
}): React.JSX.Element {
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const live = useLiveSessionCounts()
  const { busy, error, run } = useWriter()
  const [pending, setPending] = useState<Pending>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)

  const accounts = entry.accounts
  const list = accounts?.list ?? []
  const perSession = accounts?.perSession === true
  const active = list.find((account) => account.id === accounts?.activeId)
  const reauth = active?.needsReauth === true

  const opencodeOn = opencodeInstalled && entry.engines.opencode?.enabled === true
  const piOn = entry.engines.pi?.enabled === true
  const opencodeCount = useCurationSummary(
    'opencode',
    entry.engines.opencode?.providerId,
    opencodeOn,
    managing
  )
  const piCount = useCurationSummary('pi', entry.engines.pi?.providerId, piOn, managing)
  const routes: EngineId[] = [
    ...(opencodeOn ? ['opencode' as const] : []),
    ...(piOn ? ['pi' as const] : [])
  ]

  const header = (status: React.ReactNode): React.JSX.Element => (
    <CardHeader
      provider="chatgpt"
      name={entry.name}
      subtitle={
        list.length === 0
          ? 'ChatGPT Plus, Pro or Business — used by Codex, and by pi and opencode.'
          : 'ChatGPT subscription'
      }
      accounts={list.length}
      status={status}
    />
  )

  // Not signed in: the whole body is the one thing to do. A connected row with
  // no account list (a boot that could not read the vault's accounts) is still
  // connected, and keeps its engines and Manage.
  if (list.length === 0 && entry.credential !== 'connected') {
    return (
      <div data-testid={`${SUBS}.card`} data-id={entry.id}>
        {header(
          <Pill testid={`${SUBS}.cardStatus`} dataId="none">
            Not signed in
          </Pill>
        )}
        <div className="px-4 pb-4">
          <div
            data-testid={`${SUBS}.signInCta`}
            data-id={entry.id}
            className="flex items-center gap-3 p-4 rounded-[10px] border border-border bg-bg-tertiary"
          >
            <span className="flex-1 text-[12px] text-text-secondary">
              Sign in once; Codex, pi and opencode all use the same account.
            </span>
            <Button
              variant="primary"
              testid={`${SUBS}.signIn`}
              dataId={entry.id}
              onClick={() => openSignIn({ providerId: 'chatgpt', mode: 'reauth' })}
            >
              Sign in with ChatGPT
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const rows: AccountRowModel[] = list.map((account) => ({
    id: account.id,
    email: accountDisplayName(account.email),
    ...(account.planType ? { plan: account.planType } : {}),
    ...(account.accountId ? { workspace: account.accountId } : {}),
    active: account.id === accounts?.activeId,
    ...(account.needsReauth ? { needsReauth: true } : {})
  }))

  /**
   * The vault promotes the MOST RECENTLY ADDED remaining account
   * (`AuthVault.removeAccount` → `newestAccount`). The list is in the vault's
   * own order, which is insertion order — `upsertAccount` appends a new
   * account and keeps a re-login in place — so the newest is the last one left.
   */
  const removeSentence = (id: string): string => {
    const remaining = rows.filter((row) => row.id !== id)
    const successor = remaining[remaining.length - 1]
    const n = live.codexFollowing
    return removeConsequence({
      active: id === accounts?.activeId,
      ...(successor ? { successor: successor.email } : {}),
      lastAccount: 'ChatGPT is then disconnected from every engine.',
      sessions: successor
        ? chatgptSwitchConsequence(live, routes)
        : n > 0
          ? `${n} running Codex ${plural(n, 'session that follows', 'sessions that follow')} the active account ${plural(n, 'stops', 'stop')} until you sign in again.`
          : undefined
    })
  }

  const pillCount = (summary: CurationSummary | null): string | undefined =>
    summary && summary.total > 0 ? curationCount(summary) : undefined

  return (
    <div data-testid={`${SUBS}.card`} data-id={entry.id}>
      {header(
        reauth ? (
          <Pill tone="warn" testid={`${SUBS}.cardStatus`} dataId="reauth">
            Active account signed out
          </Pill>
        ) : (
          <Pill tone="ok" testid={`${SUBS}.cardStatus`} dataId="connected">
            Connected
          </Pill>
        )
      )}
      <CardError error={error} />

      <div className="px-1.5 pb-1">
        {rows.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            busy={busy}
            pending={pending}
            {...menuProps(menus, entry.id, account.id)}
            activateSentence={chatgptSwitchConsequence(live, routes)}
            removeSentence={removeSentence(account.id)}
            onPending={setPending}
            onActivate={() => {
              setPending(null)
              void run(() => window.api.switchProviderAccount(entry.id, account.id))
            }}
            onRemove={() => {
              setPending(null)
              void run(() => window.api.removeProviderAccount(entry.id, account.id))
            }}
            // Blame an account only when the vault says it is signed out; a
            // healthy one named here would read as "expired" in the dialog.
            onReauth={() =>
              openSignIn({
                providerId: 'chatgpt',
                mode: 'reauth',
                ...(account.needsReauth ? { accountId: account.id } : {})
              })
            }
          />
        ))}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3">
        <Button
          variant="link"
          testid={`${SUBS}.addAccount`}
          dataId={entry.id}
          disabled={busy}
          onClick={() => openSignIn({ providerId: 'chatgpt', mode: 'add' })}
        >
          + Add account
        </Button>
      </div>

      <EnginesRow
        trailing={
          <Button variant="tinted" testid={`${SUBS}.manage`} dataId={entry.id} onClick={onManage}>
            Manage
          </Button>
        }
      >
        <EnginePill engine="codex" on={entry.engines.codex?.enabled !== false} warn={reauth} />
        <EnginePill
          engine="opencode"
          on={opencodeOn}
          count={pillCount(opencodeCount)}
          warn={reauth}
        />
        <EnginePill engine="pi" on={piOn} count={pillCount(piCount)} warn={reauth} />
      </EnginesRow>
      {reauth && (
        <div
          data-testid={`${SUBS}.enginesWaiting`}
          className="px-4 -mt-1 pb-3 text-[12px] text-warning"
        >
          Engines are waiting for the active account to sign in again.
        </div>
      )}

      {/* One account is not a choice to make per session, so the option that
          configures that choice waits until there are two. */}
      {list.length > 1 && (
        <OptionsFold
          id={entry.id}
          open={optionsOpen}
          onOpenChange={setOptionsOpen}
          summary={
            perSession
              ? 'Codex sessions can pin an account'
              : 'All engines follow the active account'
          }
        >
          <OptionRow
            testid={`${SUBS}.perSession`}
            toggleTestid={`${SUBS}.perSessionToggle`}
            label="Pin an account per Codex session"
            description="When starting a Codex session you can choose its account; it keeps that account when you switch here. Applies to new sessions. pi and opencode always follow the active account."
            checked={perSession}
            disabled={busy}
            onToggle={() =>
              void run(() => window.api.setProviderAccountsPerSession(entry.id, !perSession))
            }
          />
        </OptionsFold>
      )}
    </div>
  )
}

// ── The section ──────────────────────────────────────────────────────────────

export function SubscriptionsSection(): React.JSX.Element {
  const registry = useSessionStore((s) => s.providerRegistry)
  /** The subscription whose Manage sheet is open. */
  const [managing, setManaging] = useState<string | null>(null)
  /** The one open ⋯ menu, across every card. */
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menus: MenuControl = { openMenu, setOpenMenu }

  // The page can open before boot's read has landed (or after one that failed).
  useEffect(() => {
    if (registry === null) void useSessionStore.getState().refreshProviderAuth()
  }, [registry])

  /** After a sheet write: re-read, and close the sheet if its entry is gone. */
  const handleWrote = useCallback(async (): Promise<void> => {
    await useSessionStore.getState().refreshProviderAuth()
    const next = useSessionStore.getState().providerRegistry
    if (next && !next.entries.some((entry) => entry.id === managing)) setManaging(null)
  }, [managing])

  if (registry === null) {
    return (
      <div data-testid={SUBS}>
        <SettingRow testid={`${SUBS}.loading`} description="Loading subscriptions…" />
      </div>
    )
  }

  const subscriptions = registry.entries.filter((entry) => entry.subscription)
  const open = subscriptions.find((entry) => entry.id === managing) ?? null

  return (
    <div data-testid={SUBS} className="divide-y divide-border/55">
      {subscriptions.map((entry) =>
        entry.origin === 'anthropic' ? (
          <AnthropicCard key={entry.id} entry={entry} menus={menus} />
        ) : (
          <ChatgptCard
            key={entry.id}
            entry={entry}
            opencodeInstalled={registry.opencodeInstalled}
            managing={managing === entry.id}
            menus={menus}
            onManage={() => setManaging(entry.id)}
          />
        )
      )}
      {open && (
        <ProviderSheet
          key={open.id}
          entry={open}
          opencodeInstalled={registry.opencodeInstalled}
          onWrote={handleWrote}
          onClose={() => setManaging(null)}
        />
      )}
    </div>
  )
}
