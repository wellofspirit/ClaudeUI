/**
 * ProviderSheet — the Manage sheet of the unified provider list (ADR-065
 * § "Providers: one list", settings-v2 phase 6b, board `board2-ProviderManage.png`).
 *
 * ONE provider identity, three questions, in the board's order: what credential
 * backs it (CREDENTIAL), which engines may use it (ENABLED FOR), and which of
 * its models reach the picker (MODELS IN THE PICKER). Everything is built from
 * the row vocabulary — the sheet invents no control of its own.
 *
 * ON A SUBSCRIPTION THE FIRST QUESTION IS PLURAL (ADR-068 §2), AND IT IS
 * ANSWERED SOMEWHERE ELSE (F14). The vault holds N ChatGPT accounts with one
 * ACTIVE; every provider's stored accounts are managed on Models & providers ›
 * Accounts, beside Anthropic's, so the Credential group becomes ONE LINK row
 * naming the count and pointing there. Two homes for one list is what that move
 * removed. Disconnect still means the whole SET — it is a provider action, not
 * an account one — so it stays in this sheet's footer. A row with no account
 * list falls back to the single-credential rows: an empty Accounts card would
 * read as "no subscription".
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
 * THE FRAME IS SHARED. Geometry, scrim, title bar, footer bar and the Escape
 * handler live in `SheetFrame.tsx`, which the Add sheet wears too — two sheets
 * mirroring the dialog's box formula separately would be two chances to get it
 * wrong.
 *
 * THE CURATION BLOCK IS ITS OWN COMPONENT, FOR EVERY ENGINE. "Models in the
 * picker" is `ModelCuration.tsx` (ADR-074 §2, mockup `7eeb6bff`): one tab per
 * engine that curates this provider, an All models / Only the ones I pick
 * choice, and the grouped, filterable list (`ModelCurationList.tsx`, follow-up
 * G) under it. It owns the reads, the scoped orphan guard and its one writer
 * (`models:set-provider-allowlist`); the sheet only says which engines can
 * curate, under which id — the id the registry puts on each engine's facts.
 *
 * WHAT IT DOES NOT OWN. Three flows here are entry points into surfaces that
 * already exist and are deliberately not re-implemented: opencode's per-model
 * capability editor (`OpencodeProviderConfigModal` → `ModelCapabilityEditor`)
 * and pi's models.json editor (`PiProviderDialog` → `PiModelEditor`) in BOTH
 * its variants — "pi models ›" opens the custom one on a pi-native declared
 * provider, "pi overrides ›" the built-in one on `entry.piBuiltinId` (a pi-native
 * built-in vendor, or a shared subscription whose enabled pi route lands on one).
 * The sheet opens each on the provider it is showing; everything they write is
 * theirs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { engineMeta } from '../../../../shared/engine-meta'
import type { ProviderCredential, ProviderEntry } from '../../../../shared/provider-registry'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderModel
} from '../../../../shared/shared-provider'
import type { EngineId, OpencodeProviderCatalogEntry } from '../../../../shared/types'
import { Button, SelectField, SettingRow, TextField, ToggleSwitch } from './settings-controls'
import {
  ModelCuration,
  opencodeCurationAdapter,
  piCurationAdapter,
  curationCount,
  type CuratedEngine,
  type CurationAdapter,
  type CurationSummary
} from './ModelCuration'
import { SheetFrame, SheetGroup } from './SheetFrame'
import type { SettingsTarget } from './settings-target'
import { ProviderForm, normalizeProviderDraft } from './ProviderForm'
import { VendorOAuthFlow } from './VendorOAuthFlow'
import { OpencodeProviderConfigModal } from './OpencodeProviders'
import { PiProviderModal } from './PiCustomProviders'

/** Testid namespace (ADR-027 tier 1/2). */
const SHEET = 'ProviderSheet'

/**
 * The row order of the ENABLED FOR group — claude first, as on the board, and
 * codex last because it is not a route at all (see {@link codexRow}).
 */
const ENGINE_ORDER: readonly EngineId[] = ['claude', 'opencode', 'pi', 'codex']

// ── Shared atoms (the list imports these; the direction is list → sheet) ──────

/** The credential badge's word. One vocabulary for the list row and the sheet. */
export const CREDENTIAL_LABEL: Record<ProviderCredential, string> = {
  'signed-in': 'Signed in',
  connected: 'Connected',
  'api-key': 'API key',
  free: 'Free',
  custom: 'Custom',
  keyless: 'No key needed',
  none: 'Not connected'
}

/**
 * Its tint. A credential ClaudeUI can VOUCH for reads as success (a live
 * sign-in), one it holds a key for reads as accent, and everything else — a
 * free gateway, a key configured outside ClaudeUI, nothing at all — is outlined:
 * three greys would say the states are interchangeable, which they are not. A
 * keyless endpoint is outlined too, but in success: needing no key is a working
 * state, not a missing one (ADR-074 §4).
 */
const CREDENTIAL_TINT: Record<ProviderCredential, string> = {
  'signed-in': 'bg-success/15 text-success',
  connected: 'bg-success/15 text-success',
  'api-key': 'bg-accent/15 text-accent',
  free: 'border border-border text-text-secondary',
  custom: 'border border-border text-text-secondary',
  keyless: 'border border-success/30 text-success',
  none: 'border border-border text-text-secondary'
}

export function CredentialChip({
  credential,
  label,
  testid
}: {
  credential: ProviderCredential
  /**
   * Overrides the WORD, never the state: a multi-account subscription reads
   * "2 accounts" while still being `connected` (ADR-068 §2), and `data-id`
   * stays the state so nothing downstream has to parse prose.
   */
  label?: string
  testid: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={credential}
      className={`shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 font-medium ${CREDENTIAL_TINT[credential]}`}
    >
      {label ?? CREDENTIAL_LABEL[credential]}
    </span>
  )
}

/** An engine chip. Dimmed when the provider does not currently reach its picker. */
export function EngineChip({
  engine,
  enabled,
  label,
  testid
}: {
  engine: EngineId
  enabled: boolean
  /**
   * Overrides the WORD, never the engine: `data-id` stays the `EngineId`, so
   * nothing downstream has to parse prose. `SignInDialog`'s header uses it to
   * name the PRODUCT the credential feeds ("Claude Code") beside a title that
   * already says "Claude"; the sheet's "Models in the picker" header uses it to
   * put each engine's curation count on its chip ("pi · 6 of 8").
   */
  label?: string
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
      {label ?? engineMeta(engine).label}
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
 * a curating engine's row carries a "Curate models" LINK beside its switch, and
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
  /** Rendered before the switch (a curating engine's "Curate models"). */
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

// ── The sheet ────────────────────────────────────────────────────────────────

export interface ProviderSheetProps {
  entry: ProviderEntry
  /** The registry's one degraded case — no opencode binary (owner ruling 2). */
  opencodeInstalled: boolean
  /**
   * The render context's navigator, threaded through the list (F14): the
   * Accounts row links to Models & providers › Accounts, where every provider's
   * stored accounts live. Absent means the link renders as plain text rather
   * than a dead button.
   */
  navigate?: (target: SettingsTarget) => void
  onClose: () => void
  /**
   * Re-read `provider-registry:list`. Resolves once the parent has the fresh
   * snapshot, and closes the sheet itself when this entry is gone from it.
   */
  onWrote: () => Promise<void>
}

export function ProviderSheet({
  entry,
  opencodeInstalled,
  navigate,
  onClose,
  onWrote
}: ProviderSheetProps): React.JSX.Element {
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
  /**
   * The ONE sign-in surface (ADR-068 §3). A subscription's sign-in used to be
   * handed to the Add sheet, which rendered `VendorOAuthFlow` inline; now both
   * the "Sign in" row and "+ Add account" open the dialog, so the Manage sheet
   * carries no flow. `VendorOAuthFlow` stays for opencode-NATIVE vendor OAuth,
   * which has no dialog driver.
   */
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** null = not editing; a string = the key being typed. Never pre-filled. */
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  const [piKeyDraft, setPiKeyDraft] = useState<string | null>(null)
  /**
   * Which destructive action is one click from happening. A string rather than a
   * union because one of them is per-ROW (`account:<id>`): arming "Remove" on
   * one account must not arm it on every other account's row too.
   */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Each engine's curation count for this provider, reported up by the curation block. */
  const [summaries, setSummaries] = useState<Partial<Record<CuratedEngine, CurationSummary>>>({})
  /** The curation tab on show — lifted so an engine row's "Curate models ›" can pick it. */
  const [curationEngine, setCurationEngine] = useState<CuratedEngine>('opencode')
  /**
   * The shared definition's own models — what a per-route DEFAULT can be. Only
   * a custom definition has any (a subscription's models come from the vendor),
   * so this read is made for exactly that case.
   */
  const [sharedModels, setSharedModels] = useState<SharedProviderModel[]>([])
  /** Which engine's own model editor is open over the sheet, if any. */
  const [modelEditor, setModelEditor] = useState<'opencode' | 'pi' | 'pi-builtin' | null>(null)
  /**
   * The definition being EDITED, over this sheet — a custom endpoint's base
   * URL, protocol and model list. Seeded from the definition when the editor
   * opens (never live-bound to it), so an abandoned edit changes nothing.
   */
  const [endpointDraft, setEndpointDraft] = useState<SharedProviderDefinition | null>(null)
  const [endpointKey, setEndpointKey] = useState('')
  const [endpointError, setEndpointError] = useState<string | null>(null)
  /**
   * The opencode catalog entry behind this row, read on demand for the config
   * modal. The modal gates its declaration form and credential block on the
   * entry's resolved `actions`; mounting it WITHOUT one grants both, and a
   * stray keystroke in a declaration form a catalog provider never had is
   * exactly the hazard that gating exists for.
   */
  const [opencodeEntry, setOpencodeEntry] = useState<OpencodeProviderCatalogEntry | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const modelsRef = useRef<HTMLDivElement>(null)
  /** "Curate models ›"'s deferred focus, cancelled if the sheet closes first. */
  const focusFrame = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    },
    []
  )

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

  useEffect(() => {
    if (definition?.kind !== 'custom') return
    let cancelled = false
    window.api
      .listSharedProviderModels(entry.id)
      .then((models) => {
        if (!cancelled) setSharedModels(models)
      })
      .catch(() => {
        if (!cancelled) setSharedModels([])
      })
    return () => {
      cancelled = true
    }
  }, [definition?.kind, entry.id])

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

  /**
   * A write this sheet did not make — an OAuth sign-in inside `VendorOAuthFlow`
   * — still changed the credential, so the registry has to be re-read and the
   * model picker's cache dropped exactly as `run` does for our own writes.
   */
  const refreshAfterExternalWrite = useCallback((): void => {
    void run(async () => {})
  }, [run])

  /** Two-click confirm: arm on the first press, act on the second. */
  const confirmThen = (which: string, action: () => Promise<void>): void => {
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

  // A keyless endpoint (ADR-074 §4) has nothing to report as "Not set": the
  // description says the key is optional instead.
  const keyless = entry.credential === 'keyless'
  const keyRow = (
    <SettingRow
      testid={`${SHEET}.credential`}
      dataId="key"
      label="API key"
      description={keyless ? 'Optional — this endpoint is used without a key.' : keyStore}
    >
      {keyDraft === null ? (
        <>
          {!keyless && (
            <span className="font-mono text-[12px] text-text-secondary">
              {entry.credential === 'api-key' ? '••••••••' : 'Not set'}
            </span>
          )}
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

  /**
   * The stored subscription accounts (ADR-068 §2), or undefined when this row has
   * none — a build with no account list, or a provider that never has one. The
   * single-credential rows below are the fallback, not an empty card: an empty
   * Accounts card reads as "you have no subscription", which is a different
   * thing from "this row does not do accounts".
   */
  const accounts =
    isShared && definition?.kind === 'subscription' && entry.accounts?.list.length
      ? entry.accounts
      : undefined

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
    // An opencode OAuth credential. Re-authorising happens HERE, through the
    // shared ADR-057 flow, rather than pointing at another pane: this sheet is
    // the provider's one home, and the pane it used to point at is gone.
    if (entry.origin === 'opencode-native' && entry.credential === 'connected') {
      return (
        <>
          <SettingRow
            testid={`${SHEET}.credential`}
            dataId="oauth"
            label="Signed in"
            description="opencode holds this OAuth credential in its own auth store. Sign in again to refresh it."
          />
          <div className="px-3.5 py-2.5">
            <VendorOAuthFlow
              engineId="opencode"
              vendorId={nativeId}
              label="Sign in again"
              disabled={busy}
              onDone={refreshAfterExternalWrite}
            />
          </div>
        </>
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
          description="One sign-in, vended to each engine you enable below."
        >
          <Button
            variant="tinted"
            testid={`${SHEET}.signIn`}
            disabled={busy}
            onClick={() => openSignIn({ providerId: 'chatgpt', mode: 'reauth' })}
          >
            Sign in
          </Button>
        </SettingRow>
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
  /**
   * The engines that can curate this provider, each under the id ITS catalog
   * and allowlist key the provider by — the registry's `providerId`, never the
   * definition id: curating ChatGPT under `chatgpt` while opencode knows it as
   * `openai` would write an allowlist nothing reads.
   *
   * opencode needs an entry in its OWN store to read a catalog from. pi's
   * catalog is read inside the block, which says why when it is empty.
   */
  const curationAdapters: CurationAdapter[] = [
    ...(opencodeInstalled &&
    opencodeFacts?.enabled === true &&
    opencodeFacts.native === true &&
    opencodeFacts.providerId
      ? [opencodeCurationAdapter(opencodeFacts.providerId)]
      : []),
    ...(piFacts?.enabled === true && piFacts.providerId
      ? [piCurationAdapter(piFacts.providerId)]
      : [])
  ]
  const curates = (engine: CuratedEngine): boolean =>
    curationAdapters.some((adapter) => adapter.engine === engine)
  const onSummary = useCallback(
    (engine: CuratedEngine, summary: CurationSummary) =>
      setSummaries((prev) =>
        prev[engine]?.total === summary.total && prev[engine]?.picked === summary.picked
          ? prev
          : { ...prev, [engine]: summary }
      ),
    []
  )

  function opencodeCount(): string {
    // The curation block's own count once it has one — the registry's lags a
    // write until the re-read, and counts ids the catalog may have dropped.
    const summary = summaries.opencode
    if (summary) {
      return summary.picked === null
        ? ` ${summary.total} models reach the picker.`
        : ` ${summary.picked} of ${summary.total} models reach the picker.`
    }
    if (opencodeFacts?.modelCount === undefined) return ''
    return ` ${opencodeFacts.modelCount} models reach the picker.`
  }

  /** "Curate models ›" on an engine row: that engine's tab, and its search box. */
  function curateLink(engine: CuratedEngine): React.ReactNode {
    if (!curates(engine)) return undefined
    return (
      <Button
        variant="link"
        testid={`${SHEET}.curate`}
        dataId={engine}
        onClick={() => {
          setCurationEngine(engine)
          // jsdom implements neither scrollIntoView nor layout.
          modelsRef.current?.scrollIntoView?.({ block: 'start' })
          filterRef.current?.focus()
          // Switching FROM a tab with no list (an empty pi catalog) mounts the
          // search box on the next render, so focus it again once it is there.
          if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
          focusFrame.current = requestAnimationFrame(() => {
            focusFrame.current = null
            filterRef.current?.focus()
          })
        }}
      >
        Curate models ›
      </Button>
    )
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
        leadingControl={curateLink('opencode')}
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
          leadingControl={curateLink('pi')}
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
          leadingControl={curateLink('pi')}
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

  /**
   * Codex, which is not a route (ADR-068 §1). The vault injects the ACTIVE
   * ChatGPT account into every app-server ClaudeUI starts, so there is nothing
   * here to enable or disable — a toggle would promise a switch the vault does
   * not have. The row exists to SAY that, and to point at the one place the
   * account is chosen.
   */
  function codexRow(): React.JSX.Element {
    return (
      <SettingRow
        testid={`${SHEET}.engine`}
        dataId="codex"
        label="Codex"
        description="Codex always uses the active ChatGPT account. Pin a different one per session from the Accounts page."
      />
    )
  }

  const engineRow = (engine: EngineId): React.JSX.Element => {
    if (engine === 'codex') return codexRow()
    if (engine === 'claude') {
      // Always off, always disabled: Claude Code talks to Anthropic's endpoint
      // and nothing else, so this row exists to SAY so rather than to be used.
      return (
        <EngineRow
          engine="claude"
          label="Claude"
          description="Claude only talks to Anthropic, or to the gateway set on Claude › Endpoint."
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

  // ── Extra entry points ─────────────────────────────────────────────────────

  /**
   * A custom shared provider's per-route DEFAULT model — the only setting the
   * vault owns that is neither a credential nor a route. One row per ENABLED
   * route, because a default for a route that delivers nothing configures
   * nothing.
   *
   * A configured model the provider no longer delivers stays selectable, so the
   * control reports what is actually saved rather than silently reading as "no
   * default".
   */
  function defaultModelRows(): React.ReactNode {
    if (!isShared || definition?.kind !== 'custom') return null
    return (['pi', 'opencode'] as ConfigurableHarnessId[])
      .filter((harness) => definition.routes[harness].enabled)
      .map((harness) => {
        const saved = definition.routes[harness].defaultModel ?? ''
        const available = sharedModels.filter(
          (model) =>
            model.harnessOverrides?.[harness]?.available !== false &&
            model.harnessOverrides?.[harness]?.enabled !== false
        )
        return (
          <SettingRow
            key={`default-${harness}`}
            testid={`${SHEET}.defaultModel`}
            dataId={harness}
            label={`Default model for ${harness}`}
            description={`What a new ${harness} session starts on when it starts on this provider.`}
          >
            <SelectField
              testid={`${SHEET}.defaultModelSelect`}
              dataId={harness}
              value={saved}
              disabled={busy}
              placeholder="No default from this provider"
              options={[
                { value: '', label: 'No default from this provider' },
                ...(saved && !available.some((model) => model.id === saved)
                  ? [{ value: saved, label: `${saved} (unavailable)` }]
                  : []),
                ...available.map((model) => ({ value: model.id, label: model.name || model.id }))
              ]}
              onChange={(value) =>
                void run(() =>
                  window.api.setSharedProviderDefaultModel(entry.id, harness, value || undefined)
                )
              }
            />
          </SettingRow>
        )
      })
  }

  /**
   * A custom shared endpoint is a DEFINITION the user wrote, and it is the one
   * thing on this sheet that is neither a credential nor a route: its base URL,
   * protocol and model list. The vault's own pane held that form until 6c, so
   * without this row a saved endpoint could never be corrected again.
   */
  function endpointGroup(): React.ReactNode {
    if (!isShared || definition?.kind !== 'custom') return null
    return (
      <SheetGroup testid={`${SHEET}.group`} id="endpoint" label="Endpoint">
        <SettingRow
          testid={`${SHEET}.endpoint`}
          label="Definition"
          description={`${definition.baseUrl || 'No base URL'} · ${definition.models.length} model${
            definition.models.length === 1 ? '' : 's'
          }`}
        >
          <Button
            variant="link"
            testid={`${SHEET}.editEndpoint`}
            disabled={busy}
            onClick={() => {
              setEndpointDraft(definition)
              setEndpointKey('')
              setEndpointError(null)
            }}
          >
            Edit endpoint ›
          </Button>
        </SettingRow>
      </SheetGroup>
    )
  }

  /** Save the edited definition, then its key if one was typed. */
  function saveEndpoint(): void {
    if (!endpointDraft) return
    const result = normalizeProviderDraft(endpointDraft)
    if ('error' in result) {
      setEndpointError(result.error)
      return
    }
    setEndpointError(null)
    void run(async () => {
      await window.api.saveSharedProvider(result.definition)
      if (endpointKey) await window.api.setSharedProviderApiKey(result.definition.id, endpointKey)
      setEndpointDraft(null)
      setEndpointKey('')
    })
  }

  /**
   * The engine's OWN model editor for this provider, opened over the sheet.
   * None is re-implemented here (see the header): opencode's declared models
   * and their capabilities live in `OpencodeProviderConfigModal`, pi's
   * models.json entry in `PiProviderDialog`.
   *
   * The two pi rows are mutually exclusive by construction, and the read model
   * is what says which: a pi-native row is `builtin` XOR `custom`, only the
   * built-in half carries `piBuiltinId`, and a shared row is never pi-native
   * custom. Declaring a models.json provider and overriding one pi ships are
   * different jobs on different entry shapes, so they are different rows rather
   * than one row that changes meaning.
   */
  function modelSetupGroup(): React.ReactNode {
    if (entry.origin === 'opencode-native') {
      return (
        <SheetGroup testid={`${SHEET}.group`} id="model-setup" label="Model setup">
          <SettingRow
            testid={`${SHEET}.modelSetup`}
            dataId="opencode"
            label="Model overrides"
            description="Declared models, and the capabilities, cost and limits opencode reads for each — in opencode's own config file."
          >
            <Button
              variant="link"
              testid={`${SHEET}.opencodeModels`}
              disabled={busy || !opencodeInstalled}
              onClick={() =>
                void window.api
                  .getOpencodeProviders()
                  .then((catalog) => {
                    setOpencodeEntry(catalog.find((p) => p.id === nativeId) ?? null)
                    setModelEditor('opencode')
                  })
                  .catch((e: unknown) => setError(message(e)))
              }
            >
              Model overrides ›
            </Button>
          </SettingRow>
        </SheetGroup>
      )
    }
    if (entry.origin === 'pi-native' && entry.piKind === 'custom') {
      return (
        <SheetGroup testid={`${SHEET}.group`} id="model-setup" label="Model setup">
          <SettingRow
            testid={`${SHEET}.modelSetup`}
            dataId="pi"
            label="pi models"
            description="This provider's models.json entry: base URL, wire protocol, and the models pi may use with it."
          >
            <Button
              variant="link"
              testid={`${SHEET}.piModels`}
              disabled={busy}
              onClick={() => setModelEditor('pi')}
            >
              pi models ›
            </Button>
          </SettingRow>
        </SheetGroup>
      )
    }
    if (entry.piBuiltinId) {
      return (
        <SheetGroup testid={`${SHEET}.group`} id="model-setup" label="Model setup">
          <SettingRow
            testid={`${SHEET}.modelSetup`}
            dataId="pi-builtin"
            label="pi overrides"
            description="Route this provider through a proxy, or change a built-in model’s context window, pricing or thinking map — in pi’s models.json."
          >
            <Button
              variant="link"
              testid={`${SHEET}.piOverrides`}
              disabled={busy}
              onClick={() => setModelEditor('pi-builtin')}
            >
              pi overrides ›
            </Button>
          </SettingRow>
        </SheetGroup>
      )
    }
    return null
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  return (
    <>
      <SheetFrame
        testid={SHEET}
        dataId={entry.id}
        title={entry.name}
        titleExtras={
          <>
            <span className="font-mono text-[11px] text-text-muted truncate">{entry.id}</span>
            <CredentialChip credential={entry.credential} testid={`${SHEET}.credentialChip`} />
          </>
        }
        onClose={onClose}
        footer={
          <>
            <Button
              variant="danger"
              testid={`${SHEET}.remove`}
              disabled={busy || remove === null}
              title={remove === null ? removeTitle : undefined}
              onClick={() => remove && confirmThen('remove', remove)}
            >
              {confirming === 'remove' ? 'Remove provider?' : 'Remove provider'}
            </Button>
            {/* With accounts, disconnecting is the whole SET — a per-account
                Remove is above, on the account it names. */}
            {accounts && (
              <Button
                variant="danger"
                testid={`${SHEET}.disconnect`}
                disabled={busy}
                onClick={() =>
                  confirmThen('disconnect', () => window.api.disconnectSharedProvider(entry.id))
                }
              >
                {confirming === 'disconnect'
                  ? 'Disconnect all accounts?'
                  : 'Disconnect all accounts'}
              </Button>
            )}
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
          </>
        }
      >
        {accounts ? (
          <SheetGroup testid={`${SHEET}.group`} id="accounts" label="Accounts">
            {/* The rows live on Models & providers › Accounts (F14), beside
                Anthropic's — one page for every provider's accounts, rather
                than one list on a page and another inside a sheet. */}
            <SettingRow
              testid={`${SHEET}.accountsLink`}
              label={`${accounts.list.length} account${accounts.list.length === 1 ? '' : 's'} · managed on Accounts`}
              description="Switching, removing and per-session pinning all live on the Accounts page."
            >
              <Button
                variant="link"
                testid={`${SHEET}.manageAccounts`}
                disabled={!navigate}
                onClick={() => {
                  // Close first: the jump lands on the page BEHIND this sheet.
                  onClose()
                  navigate?.({ page: 'models', group: 'accounts' })
                }}
              >
                Accounts ›
              </Button>
            </SettingRow>
          </SheetGroup>
        ) : (
          <SheetGroup testid={`${SHEET}.group`} id="credential" label="Credential">
            {credentialRows()}
          </SheetGroup>
        )}

        <SheetGroup
          testid={`${SHEET}.group`}
          id="enabled"
          label="Enabled for"
          trailing={
            // The vault re-delivers this definition to every enabled engine, so
            // only a shared row has anything to sync.
            isShared ? (
              <Button
                variant="link"
                testid={`${SHEET}.sync`}
                disabled={busy}
                onClick={() => void run(() => window.api.syncSharedProvider(entry.id))}
              >
                Sync now
              </Button>
            ) : undefined
          }
        >
          {/* Codex is filtered rather than rendered as null: the group card
              draws its separators with `divide-y`, so an empty wrapper would
              leave a stray rule under the last real row. */}
          {ENGINE_ORDER.filter(
            (engine) => engine !== 'codex' || entry.engines.codex !== undefined
          ).map((engine) => (
            <div key={engine}>{engineRow(engine)}</div>
          ))}
          {defaultModelRows()}
        </SheetGroup>

        {curationAdapters.length > 0 && (
          <div ref={modelsRef}>
            <SheetGroup
              testid={`${SHEET}.group`}
              id="models"
              label="Models in the picker"
              trailing={curationAdapters.map(({ engine }) => (
                // The block's count, not the registry's: the same words the tab says.
                <EngineChip
                  key={engine}
                  engine={engine}
                  enabled
                  label={`${engineMeta(engine).label} · ${curationCount(summaries[engine] ?? null)}`}
                  testid={`${SHEET}.modelsEngine`}
                />
              ))}
            >
              <ModelCuration
                testid={SHEET}
                providerName={entry.name}
                adapters={curationAdapters}
                engine={curates(curationEngine) ? curationEngine : curationAdapters[0].engine}
                onEngineChange={setCurationEngine}
                filterRef={filterRef}
                onSummary={onSummary}
                onWrote={onWrote}
              />
            </SheetGroup>
          </div>
        )}

        {endpointGroup()}
        {modelSetupGroup()}
      </SheetFrame>

      {endpointDraft && (
        <SheetFrame
          testid={`${SHEET}.endpointSheet`}
          dataId={endpointDraft.id}
          title={`Edit ${endpointDraft.name || endpointDraft.id}`}
          onClose={() => setEndpointDraft(null)}
          footer={
            <>
              <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
                Saved to the vault, then delivered to each enabled engine.
              </span>
              <Button
                variant="link"
                testid={`${SHEET}.cancelEndpoint`}
                onClick={() => setEndpointDraft(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                testid={`${SHEET}.saveEndpoint`}
                disabled={busy}
                onClick={saveEndpoint}
              >
                Save
              </Button>
            </>
          }
        >
          <ProviderForm
            draft={endpointDraft}
            onDraft={setEndpointDraft}
            apiKey={endpointKey}
            onApiKey={setEndpointKey}
            error={endpointError}
            idLocked
          />
        </SheetFrame>
      )}

      {modelEditor === 'opencode' && (
        <OpencodeProviderConfigModal
          providerId={nativeId}
          entry={opencodeEntry ?? undefined}
          onClose={() => {
            setModelEditor(null)
            setOpencodeEntry(null)
            void onWrote()
          }}
          onCredentialChanged={() => void onWrote()}
        />
      )}

      {modelEditor === 'pi' && (
        <PiProviderModal
          providerId={nativeId}
          onClose={() => {
            setModelEditor(null)
            void onWrote()
          }}
        />
      )}

      {/* `piBuiltinId`, never `nativeId`: on a shared row the native id is the
          DEFINITION id (`chatgpt`), and `providers.chatgpt` is not the entry pi
          reads its ChatGPT models from. */}
      {modelEditor === 'pi-builtin' && entry.piBuiltinId && (
        <PiProviderModal
          providerId={entry.piBuiltinId}
          builtin
          onClose={() => {
            setModelEditor(null)
            void onWrote()
          }}
        />
      )}
    </>
  )
}
