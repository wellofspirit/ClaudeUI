/**
 * ProviderSheet — the Manage sheet of the unified provider list (ADR-065
 * § "Providers: one list", settings-v2 phase 6b, board `board2-ProviderManage.png`).
 *
 * ONE provider identity, three questions, in the board's order: what credential
 * backs it (CREDENTIAL), which engines may use it (ENABLED FOR), and which of
 * its models reach the picker (MODELS IN THE PICKER). Everything is built from
 * the row vocabulary — the sheet invents no control of its own.
 *
 * IT OWNS NO STATE OF RECORD. Every action routes to an EXISTING writer, and
 * after each write the sheet asks its parent to re-read `provider-registry:list`
 * and re-render it from the fresh entry. There is no change event on the
 * registry (phase 6a), so a write the sheet did not re-read would leave the row
 * lying about what it just did — and an entry can VANISH (turning a native pi
 * provider off removes it), in which case the parent closes the sheet.
 *
 * WHERE EACH ACTION GOES, by origin — the whole point of the read model is that
 * one row can front three different stores:
 *
 *  · shared        → `shared-provider:set-route` / `:set-key` / `:disconnect` / `:remove`
 *  · opencode-native → `session:set-opencode-provider-disabled` (reversible veto),
 *                    `session:remove-opencode-provider` (with the entry's OWN
 *                    `removeKind` — never a widened one), `vendor-auth:set-key`
 *  · pi-native     → `vendor-auth:set-key` / `:remove` for a vendor pi ships an
 *                    auth option for, and a `config:patch-pi-models` delete for a
 *                    models.json provider the user declared (`piKind`)
 *
 * TWO-CLICK CONFIRMS, not a modal. Removing a provider, disconnecting a
 * subscription and turning a NATIVE pi row off all destroy something, and
 * ADR-065's vocabulary says red is always confirmed. The first press relabels
 * ("Remove provider?"), the second acts — the `Clear password` pattern, which
 * keeps the confirmation in the row that owns it instead of stacking a dialog
 * on a sheet on a dialog. A shared route toggle is NOT confirmed: it is
 * reversible with one click and destroys no credential.
 *
 * DELIBERATE GEOMETRY. The sheet is a `fixed` overlay that reproduces the
 * dialog's own box (`View.tsx`: `min(1040px, 92vw/scale) × min(700px, 88vh/scale)`,
 * centred) and pins itself to that box's right edge below the 52px header, so it
 * reads as part of the dialog rather than as another stacked modal. It mirrors
 * the formula instead of measuring, because the dialog renders under CSS `zoom`
 * and a measured rect and a `fixed` inset resolve in different coordinate
 * spaces. On a phone (`useIsMobile`) the whole thing is the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { engineMeta } from '../../../../shared/engine-meta'
import { findModelReferences, formatModelReferences } from '../../../../shared/model-references'
import type { ProviderCredential, ProviderEntry } from '../../../../shared/provider-registry'
import type { SharedProviderDefinition } from '../../../../shared/shared-provider'
import type {
  EngineConfig,
  EngineId,
  EngineModelGroup,
  ModelInfo,
  OpencodeCatalogModel,
  OpencodeConfigSettings
} from '../../../../shared/types'
import { Button, ChipSet, SettingRow, TextField, ToggleSwitch } from './settings-controls'
import type { SettingsTarget } from './settings-target'

/** Testid namespace (ADR-027 tier 1/2). */
const SHEET = 'ProviderSheet'

/** How many model chips render before the "Show all" link (the board's density). */
const CHIP_PREVIEW = 12

/** The row order of the ENABLED FOR group — claude first, as on the board. */
const ENGINE_ORDER: readonly EngineId[] = ['claude', 'opencode', 'pi']

// ── Shared atoms (the list imports these; the direction is list → sheet) ──────

/** The credential badge's word. One vocabulary for the list row and the sheet. */
export const CREDENTIAL_LABEL: Record<ProviderCredential, string> = {
  'signed-in': 'Signed in',
  connected: 'Connected',
  'api-key': 'API key',
  free: 'Free',
  custom: 'Custom',
  none: 'Not connected'
}

/**
 * Its tint. A credential ClaudeUI can VOUCH for reads as success (a live
 * sign-in), one it holds a key for reads as accent, and everything else — a
 * free gateway, a key configured outside ClaudeUI, nothing at all — is outlined:
 * three greys would say the states are interchangeable, which they are not.
 */
const CREDENTIAL_TINT: Record<ProviderCredential, string> = {
  'signed-in': 'bg-success/15 text-success',
  connected: 'bg-success/15 text-success',
  'api-key': 'bg-accent/15 text-accent',
  free: 'border border-border text-text-secondary',
  custom: 'border border-border text-text-secondary',
  none: 'border border-border text-text-secondary'
}

export function CredentialChip({
  credential,
  testid
}: {
  credential: ProviderCredential
  testid: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={credential}
      className={`shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 font-medium ${CREDENTIAL_TINT[credential]}`}
    >
      {CREDENTIAL_LABEL[credential]}
    </span>
  )
}

/** An engine chip. Dimmed when the provider does not currently reach its picker. */
export function EngineChip({
  engine,
  enabled,
  testid
}: {
  engine: EngineId
  enabled: boolean
  testid: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={engine}
      data-enabled={enabled ? 'true' : 'false'}
      className={`shrink-0 border rounded-full px-[7px] text-[10.5px] leading-4 ${
        enabled
          ? 'border-border text-text-secondary'
          : 'border-border/50 text-text-muted opacity-50'
      }`}
    >
      {engineMeta(engine).label}
    </span>
  )
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** The id the ENGINE's own store knows this provider by (`opencode:` / `pi:` stripped). */
export function nativeProviderId(entry: ProviderEntry): string {
  const colon = entry.id.indexOf(':')
  return entry.origin === 'opencode-native' || entry.origin === 'pi-native'
    ? entry.id.slice(colon + 1)
    : entry.id
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * One ENABLED-FOR row.
 *
 * Built from `SettingRow` + a bare switch rather than `SettingsToggle`, because
 * the opencode row carries a "Curate models" LINK beside its switch and
 * `SettingsToggle` makes the whole row a `<button>` — a link inside it would be
 * a button inside a button. One shape for all three rows keeps the testids
 * uniform: `ProviderSheet.engine` is the row, `ProviderSheet.engineToggle` the
 * switch, both discriminated by the engine id.
 */
function EngineRow({
  engine,
  label,
  description,
  checked,
  disabled = false,
  dimmed = false,
  onToggle,
  leadingControl
}: {
  engine: EngineId
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  dimmed?: boolean
  onToggle: () => void
  /** Rendered before the switch (the opencode row's "Curate models"). */
  leadingControl?: React.ReactNode
}): React.JSX.Element {
  return (
    <SettingRow
      testid={`${SHEET}.engine`}
      dataId={engine}
      label={label}
      description={description}
      dimmed={dimmed}
    >
      {leadingControl}
      <button
        type="button"
        data-testid={`${SHEET}.engineToggle`}
        data-id={engine}
        aria-pressed={checked}
        disabled={disabled}
        onClick={onToggle}
        className="cursor-default disabled:opacity-40"
      >
        <ToggleSwitch checked={checked} />
      </button>
    </SettingRow>
  )
}

/** A group header inside the sheet: the board's caps label, plus an optional chip. */
function SheetGroup({
  id,
  label,
  trailing,
  children
}: {
  id: string
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={`${SHEET}.group`} data-id={id} className="mt-5 first:mt-0">
      <div className="flex items-center gap-3 h-8 px-1 mb-2">
        <span className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          {label}
        </span>
        {trailing}
      </div>
      <div className="border border-border rounded-lg bg-bg-secondary overflow-hidden divide-y divide-border/55">
        {children}
      </div>
    </div>
  )
}

// ── The sheet ────────────────────────────────────────────────────────────────

export interface ProviderSheetProps {
  entry: ProviderEntry
  /** The registry's one degraded case — no opencode binary (owner ruling 2). */
  opencodeInstalled: boolean
  onClose: () => void
  /**
   * Re-read `provider-registry:list`. Resolves once the parent has the fresh
   * snapshot, and closes the sheet itself when this entry is gone from it.
   */
  onWrote: () => Promise<void>
  navigate?: (target: SettingsTarget) => void
}

export function ProviderSheet({
  entry,
  opencodeInstalled,
  onClose,
  onWrote,
  navigate
}: ProviderSheetProps): React.JSX.Element {
  const isMobile = useIsMobile()
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  /**
   * The shared DEFINITION behind a shared row. The read model deliberately does
   * not carry `kind` — but a disconnected subscription and a disconnected custom
   * endpoint are both `credential: 'none'`, and they need opposite affordances
   * (sign in vs. paste a key). It also says whether Remove is even legitimate:
   * a built-in definition is ClaudeUI's, not the user's.
   *
   * `resolved` is separate from the value on purpose: a definition that is
   * ABSENT (or a read that failed) is an answer, and folding it into `null`
   * would leave the credential group saying "Loading…" for ever.
   */
  const [shared, setShared] = useState<{
    resolved: boolean
    definition: SharedProviderDefinition | null
  }>({ resolved: false, definition: null })
  const definition = shared.definition
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** null = not editing; a string = the key being typed. Never pre-filled. */
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  const [piKeyDraft, setPiKeyDraft] = useState<string | null>(null)
  /** Which destructive action is one click from happening. */
  const [confirming, setConfirming] = useState<'remove' | 'pi-off' | 'disconnect' | null>(null)
  /** The provider's catalog size, reported up by the curation block. */
  const [catalogTotal, setCatalogTotal] = useState<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const modelsRef = useRef<HTMLDivElement>(null)

  const isShared = entry.origin === 'shared'
  const nativeId = nativeProviderId(entry)

  useEffect(() => {
    if (!isShared) return
    let cancelled = false
    window.api
      .listSharedProviders()
      .then((list) => {
        if (!cancelled)
          setShared({ resolved: true, definition: list.find((d) => d.id === entry.id) ?? null })
      })
      .catch(() => {
        if (!cancelled) setShared({ resolved: true, definition: null })
      })
    return () => {
      cancelled = true
    }
  }, [isShared, entry.id])

  // Escape closes. Capture so a nested control cannot swallow it, and stop the
  // event so the settings dialog behind does not close along with the sheet.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  /**
   * Run one write: the model picker's cache is dropped, the registry is re-read,
   * and a rejection stays on the sheet rather than being swallowed — a silent
   * no-op is exactly how a credential surface loses trust.
   */
  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await action()
        useSessionStore.getState().reloadModels()
        await onWrote()
      } catch (e) {
        setError(message(e))
      } finally {
        setBusy(false)
      }
    },
    [onWrote]
  )

  /** Two-click confirm: arm on the first press, act on the second. */
  const confirmThen = (
    which: 'remove' | 'pi-off' | 'disconnect',
    action: () => Promise<void>
  ): void => {
    if (confirming !== which) {
      setConfirming(which)
      return
    }
    setConfirming(null)
    void run(action)
  }

  const saveKey = (key: string): void => {
    void run(async () => {
      if (isShared) await window.api.setSharedProviderApiKey(entry.id, key)
      else
        await window.api.vendorAuthSetKey(
          entry.origin === 'pi-native' ? 'pi' : 'opencode',
          nativeId,
          key
        )
      setKeyDraft(null)
    })
  }

  // ── CREDENTIAL ─────────────────────────────────────────────────────────────

  const keyStore =
    entry.origin === 'shared'
      ? "Kept in each enabled engine's own auth file, never in ClaudeUI's config."
      : entry.origin === 'pi-native'
        ? "Stored in pi's own auth.json, never in ClaudeUI's config."
        : "Stored in opencode's own auth.json, never in ClaudeUI's config."

  const keyRow = (
    <SettingRow testid={`${SHEET}.credential`} dataId="key" label="API key" description={keyStore}>
      {keyDraft === null ? (
        <>
          <span className="font-mono text-[12px] text-text-secondary">
            {entry.credential === 'api-key' ? '••••••••' : 'Not set'}
          </span>
          <Button variant="link" testid={`${SHEET}.replaceKey`} onClick={() => setKeyDraft('')}>
            {entry.credential === 'api-key' ? 'Replace' : 'Add key'}
          </Button>
        </>
      ) : (
        <>
          <TextField
            type="password"
            testid={`${SHEET}.keyInput`}
            value={keyDraft}
            onChange={setKeyDraft}
            placeholder="Paste the key"
            className="w-[150px]"
          />
          <Button
            variant="link"
            testid={`${SHEET}.saveKey`}
            disabled={busy || keyDraft.trim().length === 0}
            onClick={() => saveKey(keyDraft.trim())}
          >
            Save
          </Button>
        </>
      )}
    </SettingRow>
  )

  function credentialRows(): React.JSX.Element {
    if (isShared && !shared.resolved) {
      return <SettingRow testid={`${SHEET}.credential`} dataId="loading" description="Loading…" />
    }
    if (entry.credential === 'free') {
      return (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="free"
          label="No credential needed."
          description="This provider is reachable without signing in."
        />
      )
    }
    if (entry.credential === 'custom') {
      return (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="external"
          label="Configured outside ClaudeUI"
          description="The key comes from an environment variable or a config file ClaudeUI does not own, so there is nothing here to replace."
        />
      )
    }
    // An opencode OAuth credential: the paste-back flow and its state machine
    // live in the opencode provider pane (ADR-057), so this points at it rather
    // than growing a second copy that could disagree with it.
    if (entry.origin === 'opencode-native' && entry.credential === 'connected') {
      return (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="oauth"
          label="Signed in"
          description="opencode holds this OAuth credential in its own auth store."
        >
          <Button
            variant="link"
            testid={`${SHEET}.oauthLink`}
            onClick={() => {
              navigate?.({ page: 'models', group: 'providers-opencode' })
              onClose()
            }}
          >
            Manage sign-in
          </Button>
        </SettingRow>
      )
    }
    if (isShared && definition?.kind === 'subscription') {
      return entry.credential === 'connected' ? (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="subscription"
          label={`Connected as ${definition.name}`}
          description="One sign-in, vended to each engine you enable below."
        >
          <Button
            variant="danger"
            testid={`${SHEET}.disconnect`}
            disabled={busy}
            onClick={() =>
              confirmThen('disconnect', () => window.api.disconnectSharedProvider(entry.id))
            }
          >
            {confirming === 'disconnect' ? 'Disconnect?' : 'Disconnect'}
          </Button>
        </SettingRow>
      ) : (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="subscription"
          label="Not connected"
          description="Signing in to a subscription arrives with the Add provider sheet."
        />
      )
    }
    if (entry.origin === 'pi-native' && entry.credential === 'connected') {
      return (
        <SettingRow
          testid={`${SHEET}.credential`}
          dataId="subscription"
          label="Connected"
          description="pi holds this subscription; its sign-in runs in a terminal, not in ClaudeUI."
        />
      )
    }
    return keyRow
  }

  // ── ENABLED FOR ────────────────────────────────────────────────────────────

  const opencodeFacts = entry.engines.opencode
  const piFacts = entry.engines.pi
  /** The id opencode's own catalog and allowlist key this provider by. */
  const opencodeId =
    entry.origin === 'opencode-native'
      ? nativeId
      : (definition?.routes.opencode.providerId ?? entry.id)
  /**
   * Curation needs an entry in opencode's OWN store to read a catalog from —
   * and, for a shared row, the definition that says WHICH id that entry has:
   * curating under the definition id while the real one is `openai` would write
   * an allowlist nothing reads.
   */
  const curatable =
    opencodeInstalled &&
    opencodeFacts?.enabled === true &&
    opencodeFacts.native === true &&
    (!isShared || shared.resolved)

  function opencodeCount(): string {
    if (opencodeFacts?.modelCount === undefined) return ''
    if (opencodeFacts.curated && catalogTotal !== null) {
      return ` ${opencodeFacts.modelCount} of ${catalogTotal} models reach the picker.`
    }
    return ` ${opencodeFacts.modelCount} models reach the picker.`
  }

  function opencodeRow(): React.JSX.Element {
    if (!opencodeInstalled || !opencodeFacts) {
      return (
        <SettingRow
          testid={`${SHEET}.engine`}
          dataId="opencode"
          dimmed
          label="opencode"
          description={
            opencodeInstalled
              ? 'Not set up in opencode. Add it under opencode providers.'
              : 'opencode is not installed.'
          }
        />
      )
    }
    const lead = entry.origin === 'opencode-native' ? 'Catalog provider.' : 'Shared credential.'
    return (
      <EngineRow
        engine="opencode"
        label="opencode"
        description={`${lead}${opencodeCount()}`}
        checked={opencodeFacts.enabled}
        disabled={busy}
        leadingControl={
          curatable ? (
            <Button
              variant="link"
              testid={`${SHEET}.curate`}
              onClick={() => {
                // jsdom implements neither scrollIntoView nor layout.
                modelsRef.current?.scrollIntoView?.({ block: 'start' })
                filterRef.current?.focus()
              }}
            >
              Curate models ›
            </Button>
          ) : undefined
        }
        onToggle={() =>
          void run(() =>
            entry.origin === 'opencode-native'
              ? // opencode's own reversible veto, not a removal.
                window.api.setOpencodeProviderDisabled(nativeId, opencodeFacts.enabled)
              : window.api.setSharedProviderRoute(entry.id, 'opencode', !opencodeFacts.enabled)
          )
        }
      />
    )
  }

  function piRow(): React.JSX.Element {
    // A route the vault owns: reversible in one click, so no confirm.
    if (isShared) {
      const on = piFacts?.enabled === true
      return (
        <EngineRow
          engine="pi"
          label="pi"
          description="Off stops vending this credential to pi; turning it back on re-delivers it."
          checked={on}
          disabled={busy}
          onToggle={() => void run(() => window.api.setSharedProviderRoute(entry.id, 'pi', !on))}
        />
      )
    }
    // A native pi row IS its auth.json entry (or its models.json declaration),
    // so OFF removes it outright (owner ruling 1) — hence the two-click confirm.
    if (piFacts?.enabled) {
      return (
        <EngineRow
          engine="pi"
          label={confirming === 'pi-off' ? 'Remove from pi?' : 'pi'}
          description="Off removes it from pi; turning it back on asks for the key again."
          checked
          disabled={busy}
          onToggle={() =>
            confirmThen('pi-off', () =>
              entry.piKind === 'custom'
                ? // A models.json declaration: deleting the leaf IS the removal.
                  window.api.patchPiModels([{ path: ['providers', nativeId] }])
                : window.api.vendorAuthRemove('pi', nativeId)
            )
          }
        />
      )
    }
    // Not in pi: there is no credential to switch back on, so the toggle is
    // replaced by the affordance that would actually put it there.
    return (
      <SettingRow
        testid={`${SHEET}.engine`}
        dataId="pi"
        label="pi"
        description="Add a key to use it in pi. pi keeps credentials in its own auth.json."
      >
        {piKeyDraft === null ? (
          <Button variant="link" testid={`${SHEET}.piAddKey`} onClick={() => setPiKeyDraft('')}>
            Add key
          </Button>
        ) : (
          <>
            <TextField
              type="password"
              testid={`${SHEET}.piKeyInput`}
              value={piKeyDraft}
              onChange={setPiKeyDraft}
              placeholder="Paste the key"
              className="w-[150px]"
            />
            <Button
              variant="link"
              testid={`${SHEET}.piSaveKey`}
              disabled={busy || piKeyDraft.trim().length === 0}
              onClick={() =>
                void run(async () => {
                  await window.api.vendorAuthSetKey('pi', nativeId, piKeyDraft.trim())
                  setPiKeyDraft(null)
                })
              }
            >
              Save
            </Button>
          </>
        )}
      </SettingRow>
    )
  }

  const engineRow = (engine: EngineId): React.JSX.Element => {
    if (engine === 'claude') {
      // Always off, always disabled: Claude Code talks to Anthropic's endpoint
      // and nothing else, so this row exists to SAY so rather than to be used.
      return (
        <EngineRow
          engine="claude"
          label="Claude"
          description="Claude only talks to Anthropic, or to the endpoint set under Anthropic endpoint."
          checked={entry.engines.claude?.enabled === true}
          disabled
          dimmed
          onToggle={() => {}}
        />
      )
    }
    return engine === 'opencode' ? opencodeRow() : piRow()
  }

  // ── Removal ────────────────────────────────────────────────────────────────

  /** Null when nothing here may legitimately remove this provider. */
  function removeAction(): (() => Promise<void>) | null {
    if (isShared) {
      // A built-in definition is ClaudeUI's own; only a user-declared one is the
      // user's to delete. Disconnect is the reversible verb for the other.
      return definition?.kind === 'custom' ? () => window.api.removeSharedProvider(entry.id) : null
    }
    if (entry.origin === 'opencode-native') {
      const kind = entry.opencodeRemoveKind
      return kind ? () => window.api.removeOpencodeProvider(nativeId, kind) : null
    }
    if (entry.origin === 'pi-native') {
      return entry.piKind === 'custom'
        ? () => window.api.patchPiModels([{ path: ['providers', nativeId] }])
        : () => window.api.vendorAuthRemove('pi', nativeId)
    }
    return null
  }

  const remove = removeAction()
  const removeTitle = isShared
    ? 'Built-in providers cannot be removed — disconnect it instead.'
    : 'This provider is not ClaudeUI’s to remove.'

  // ── Frame ──────────────────────────────────────────────────────────────────

  const panel = (
    <div
      data-testid={SHEET}
      data-id={entry.id}
      className={`pointer-events-auto flex flex-col bg-bg-primary animate-fade-in ${
        isMobile ? 'w-full h-full' : 'w-[560px] max-w-full h-full border-l border-border shadow-2xl'
      }`}
    >
      {/* Title: name · id · credential badge · close */}
      <div className="h-[52px] shrink-0 flex items-center gap-2 px-4 border-b border-border">
        <span className="text-[15px] font-semibold text-text-primary truncate">{entry.name}</span>
        <span className="font-mono text-[11px] text-text-muted truncate">{entry.id}</span>
        <CredentialChip credential={entry.credential} testid={`${SHEET}.credentialChip`} />
        <button
          type="button"
          data-testid={`${SHEET}.close`}
          title="Close"
          onClick={onClose}
          className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <SheetGroup id="credential" label="Credential">
          {credentialRows()}
        </SheetGroup>

        <SheetGroup id="enabled" label="Enabled for">
          {ENGINE_ORDER.map((engine) => (
            <div key={engine}>{engineRow(engine)}</div>
          ))}
        </SheetGroup>

        {curatable && (
          <div ref={modelsRef}>
            <SheetGroup
              id="models"
              label="Models in the picker"
              trailing={<EngineChip engine="opencode" enabled testid={`${SHEET}.modelsEngine`} />}
            >
              <OpencodeModelCuration
                providerId={opencodeId}
                filterRef={filterRef}
                onTotal={setCatalogTotal}
                onWrote={onWrote}
              />
            </SheetGroup>
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border">
        <Button
          variant="danger"
          testid={`${SHEET}.remove`}
          disabled={busy || remove === null}
          title={remove === null ? removeTitle : undefined}
          onClick={() => remove && confirmThen('remove', remove)}
        >
          {confirming === 'remove' ? 'Remove provider?' : 'Remove provider'}
        </Button>
        {/* One error slot for every write on the sheet: the row that failed is
            always visible above it, and three copies of the same banner is how
            a surface ends up reporting a stale failure next to a fresh row. */}
        <span
          data-testid={`${SHEET}.error`}
          className="flex-1 min-w-0 truncate text-[12px] text-danger"
        >
          {error}
        </span>
        <Button variant="primary" testid={`${SHEET}.done`} onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )

  if (isMobile) {
    return <div className="fixed inset-0 z-[100] flex">{panel}</div>
  }
  return (
    // The dialog's own geometry, mirrored rather than measured — see the header.
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div
        style={{
          width: `min(1040px, calc(92vw / ${uiFontScale}))`,
          height: `min(700px, calc(88vh / ${uiFontScale}))`
        }}
        className="relative flex justify-end pt-[52px] overflow-hidden rounded-xl"
      >
        <span
          data-testid={`${SHEET}.scrim`}
          onClick={onClose}
          className="absolute inset-0 pointer-events-auto bg-black/30"
        />
        {panel}
      </div>
    </div>
  )
}

// ── Model curation (opencode only this phase) ────────────────────────────────

/**
 * Which of a provider's catalog models reach ClaudeUI's picker
 * (`opencodeConfig.modelAllowlist[providerId]`, the very list
 * `ModelAllowlistDialog` edits). Absent means "all of them", so an absent list
 * shows every chip selected and the first de-selection writes an explicit list.
 *
 * Commits per chip, as the row vocabulary requires — with the ORPHAN GUARD the
 * old dialog carries: hiding a model some setting still names would break that
 * setting with no way back from here, so a blocked edit is refused and says
 * which setting blocked it, rather than applied with a warning.
 */
function OpencodeModelCuration({
  providerId,
  filterRef,
  onTotal,
  onWrote
}: {
  providerId: string
  filterRef: React.RefObject<HTMLInputElement | null>
  onTotal: (total: number) => void
  onWrote: () => Promise<void>
}): React.JSX.Element {
  const [models, setModels] = useState<OpencodeCatalogModel[] | null>(null)
  const [cfg, setCfg] = useState<OpencodeConfigSettings | null>(null)
  /** Discovered opencode models — the set an edit can actually make disappear. */
  const [discovered, setDiscovered] = useState<ModelInfo[]>([])
  /** Every engine's ClaudeUI config: a cross-engine dispatch default names these too. */
  const [engineConfigs, setEngineConfigs] = useState<Partial<Record<EngineId, EngineConfig>>>({})
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getOpencodeProviderModels(providerId)
      .then((list) => {
        if (cancelled) return
        setModels(list)
        onTotal(list.length)
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [providerId, onTotal])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.loadOpencodeSettings().catch(() => ({}) as OpencodeConfigSettings),
      window.api.getEngineModels().catch((): EngineModelGroup[] => []),
      Promise.all(
        (['claude', 'opencode', 'pi'] as EngineId[]).map(
          async (id) =>
            [id, await window.api.loadEngineConfig(id).catch(() => ({}) as EngineConfig)] as const
        )
      )
    ]).then(([settings, groups, configs]) => {
      if (cancelled) return
      setCfg(settings)
      setDiscovered(groups.filter((g) => g.engineId === 'opencode').flatMap((g) => g.models))
      setEngineConfigs(Object.fromEntries(configs))
    })
    return () => {
      cancelled = true
    }
  }, [providerId])

  if (models === null || cfg === null) {
    return <SettingRow testid={`${SHEET}.models`} dataId="loading" description="Loading models…" />
  }

  const allowlist = cfg.modelAllowlist ?? {}
  const all = models.map((m) => m.id)
  // Absent = "everything currently shown", the same reading the allowlist dialog
  // seeds itself with — so the chips must show every model selected.
  const selected = allowlist[providerId] ?? all

  const save = (next: string[]): void => {
    // References are stored as picker VALUES, and only DISCOVERED models can be
    // orphaned — a catalog id opencode never surfaced is not naming anything.
    const kept = new Set(next.map((id) => `${providerId}/${id}`))
    const removed = discovered
      .filter((m) => m.vendorId === providerId && !kept.has(m.value))
      .map((m) => m.value)
    const refs = findModelReferences({ opencode: cfg, engines: engineConfigs }, removed)
    if (refs.length > 0) {
      setError(formatModelReferences(refs))
      return
    }
    setError(null)
    const updated: OpencodeConfigSettings = {
      ...cfg,
      modelAllowlist: { ...allowlist, [providerId]: next }
    }
    setCfg(updated)
    window.api
      .saveOpencodeSettings(updated)
      .then(() => {
        useSessionStore.getState().reloadModels()
        return onWrote()
      })
      .catch((e: unknown) => setError(message(e)))
  }

  const q = filter.trim().toLowerCase()
  const matching = models.filter(
    (m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  )
  const shown = showAll ? matching : matching.slice(0, CHIP_PREVIEW)

  return (
    <SettingRow
      testid={`${SHEET}.models`}
      dataId={providerId}
      layout="stacked"
      label="Shown in the picker"
      description={`${selected.length} of ${models.length} selected. Nothing here changes what opencode itself can reach.`}
      error={error ?? undefined}
      errorTestid={`${SHEET}.modelsError`}
    >
      <span className="block space-y-2">
        <input
          ref={filterRef}
          type="text"
          data-testid={`${SHEET}.modelFilter`}
          value={filter}
          placeholder={`Filter ${models.length} models…`}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setFilter(e.target.value)}
          className="w-full h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
        />
        <ChipSet
          testid={`${SHEET}.modelChips`}
          value={selected}
          options={shown.map((m) => ({ value: m.id, label: m.name || m.id }))}
          onToggle={(id) =>
            save(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id])
          }
          trailing={
            matching.length > shown.length ? (
              <button
                type="button"
                data-testid={`${SHEET}.showAll`}
                onClick={() => setShowAll(true)}
                className="text-[11px] leading-[18px] text-accent hover:text-accent-hover cursor-default"
              >
                Show all {matching.length}
              </button>
            ) : undefined
          }
        />
      </span>
    </SettingRow>
  )
}
