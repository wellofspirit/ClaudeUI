/**
 * OpencodeProviders.tsx
 *
 * Settings › opencode › Providers: the catalog-driven add/auth/curate surface
 * (`VendorOpencodeSection`), the per-provider configuration dialog
 * (`OpencodeProviderConfigModal`) and the model-allowlist dialog they open.
 *
 * Lifted out of settings-sections.tsx — which had grown to hold this whole
 * surface inline — and restyled onto the shared provider-editor frame
 * (provider-editor-shell.tsx), the one pi's models.json editor wears. Nothing
 * about WHAT it does moved: the auth state machines (desktop `oauthFlow` and
 * ADR-057's web paste-back off the store's `vendorOAuth`), the reversible
 * disable veto, the kind-resolved removal, the orphan guards and the
 * shared-provider claims are the same code at a new address.
 *
 * WHERE THINGS LIVE NOW. The old row carried five icon actions; the mockup
 * (.claude/ui/mockups/eb489761) folds them into a dialog opened by clicking the
 * row. Two are kept on the row as a deliberate deviation:
 *
 *  · manage models / update credential / configure declaration → THE DIALOG.
 *    Each of those is a considered edit, and burying the credential panel's
 *    OAuth machinery in a row that also has to fit four other controls is what
 *    made the row unreadable.
 *  · disable and remove STAY on the row. Disable is a reversible veto and
 *    Remove is destructive; keeping them one click apart from each other, and
 *    one click from the list, is the whole point of having separated them.
 *
 * THREE STATES FOR THE CATALOG, not one. `discoverOpencodeProviderCatalog`
 * swallows its own failures and answers `[]`, and `acquire()` may be spawning
 * the opencode server (seconds, on a cold boot). The pane therefore separates:
 * still loading (say the server is starting), resolved-but-empty or rejected
 * (the catalog ships ~146 entries, so nothing at all means the server did not
 * answer — offer Retry), and a healthy catalog with no CONFIGURED provider yet
 * (the genuine empty state). They used to render the same "No providers yet"
 * line, which said "add one" to a user whose server had not come up.
 */

import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../../stores/session-store'
import type {
  EngineConfig,
  EngineId,
  ModelInfo,
  OpencodeCatalogModel,
  OpencodeConfigSettings,
  OpencodeProviderCatalogEntry,
  OpencodeProviderSettings,
  ProviderRemoveKind,
  VendorAuthOption
} from '../../../../shared/types'
import { ENGINE_META } from '../../../../shared/engine-meta'
import { findModelReferences, formatModelReferences } from '../../../../shared/model-references'
import {
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  classifyOAuthError
} from '../auth/OAuthPasteBackFlow'
import { ConfirmModal } from '../shared/ConfirmModal'
import { IconButton, PowerIcon, TrashIcon } from './ProviderRowIcons'
import { inputClass } from './OpencodeSchemaForm'
import { LeafRow, StackedRow } from './OpencodeConfigPanes'
import { BlockHeader, DialogShell, EntityRowCard } from './provider-editor-shell'
import { ModelCapabilityEditor } from './OpencodeModelCapabilities'
import { useOpencodeInstalled } from './use-engine-installed'

/** Testid namespaces (ADR-027 tier 2) for the pane and its two dialogs. */
const PANE = 'VendorOpencodeSection'
const DIALOG = 'OpencodeProviderConfigModal'
const ALLOWLIST = 'ModelAllowlistDialog'

/** The DESKTOP oauth flow's local stages (the web flow lives on the store). */
type VendorOAuthFlowState =
  | { stage: 'idle' }
  | { stage: 'instructions'; url: string; instructions: string; method: number; vendorId: string }
  | { stage: 'submitting'; vendorId: string }

// ── Model allowlist dialog ───────────────────────────────────────────────────

/**
 * Per-provider model-allowlist dialog. Lists every catalog model for a provider
 * so the user picks which appear in the model picker — preventing huge providers
 * (openrouter ships 300+) from flooding it.
 *
 * Semantics: an undefined incoming allowlist means "all currently shown", so we
 * pre-check every model (saving then writes an explicit list). A defined list
 * pre-checks exactly those ids. Saving an empty selection writes [] → no models.
 *
 * Keeps its own frame rather than the shared `DialogShell`: its search bar and
 * orphan-error slot are PINNED outside the scrolling list, and a 300-model list
 * that scrolls its own search field away is a worse dialog than a consistent
 * one. `stacked` is the shell's z rung, borrowed — it is opened both from the
 * pane (z-[100] rung free) and from the provider dialog (which holds it).
 */
function ModelAllowlistDialog({
  providerId,
  providerName,
  current,
  error,
  stacked = false,
  onSave,
  onClose
}: {
  providerId: string
  providerName: string
  current: string[] | undefined
  /** Blocking orphan-guard message from the last save attempt; keeps the dialog open. */
  error?: string | null
  /** True when opened from the provider dialog, which already holds z-[100]. */
  stacked?: boolean
  onSave: (ids: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [models, setModels] = useState<OpencodeCatalogModel[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set(current ?? []))
  const [search, setSearch] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  // When the incoming allowlist is undefined (legacy "show all"), default every
  // model to checked once the list loads so saving doesn't silently hide them.
  const seededRef = useRef(current !== undefined)

  useEffect(() => {
    let cancelled = false
    window.api
      .getOpencodeProviderModels(providerId)
      .then((list) => {
        if (cancelled) return
        setModels(list)
        if (!seededRef.current) {
          seededRef.current = true
          setChecked(new Set(list.map((m) => m.id)))
        }
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const hasFreeModels = (models ?? []).some((m) => m.free)
  const filtered = (models ?? []).filter((m) => {
    // Ignore a stale toggle when the loaded entries contain no free models — the
    // chip is unmounted then, so an active filter would otherwise leave a
    // permanently empty list (same dead-end guard as ModelPicker.displayedGroups).
    if (freeOnly && hasFreeModels && !m.free) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  })

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      data-testid={ALLOWLIST}
      className={`fixed inset-0 ${stacked ? 'z-[105]' : 'z-[100]'} flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in`}
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] max-h-[80vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-text-primary">Models · {providerName}</div>
            <div className="text-[11px] text-text-muted/70">
              Pick which models appear in the picker. {checked.size} selected.
            </div>
          </div>
          <button
            data-testid={`${ALLOWLIST}.close`}
            aria-label="Close"
            onClick={onClose}
            className="text-text-muted/60 hover:text-text-primary transition-colors text-[16px] leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
          <input
            type="text"
            data-testid={`${ALLOWLIST}.search`}
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
          />
          <button
            data-testid={`${ALLOWLIST}.selectAll`}
            onClick={() => setChecked(new Set((models ?? []).map((m) => m.id)))}
            className="text-[10px] text-accent hover:text-accent/80 transition-colors whitespace-nowrap"
          >
            Select all
          </button>
          <button
            data-testid={`${ALLOWLIST}.clear`}
            onClick={() => setChecked(new Set())}
            className="text-[10px] text-text-muted/70 hover:text-text-primary transition-colors whitespace-nowrap"
          >
            Clear
          </button>
          {hasFreeModels && (
            <button
              type="button"
              data-testid={`${ALLOWLIST}.freeFilter`}
              aria-pressed={freeOnly}
              onClick={() => setFreeOnly((v) => !v)}
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide transition-colors cursor-pointer border whitespace-nowrap ${
                freeOnly
                  ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                  : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
              }`}
            >
              Free only
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {models === null ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">Loading models…</div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">No models match.</div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                data-testid={`${ALLOWLIST}.modelRow`}
                data-id={m.id}
                onClick={() => toggle(m.id)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-left cursor-default"
              >
                <span
                  className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] ${
                    checked.has(m.id)
                      ? 'bg-accent border-accent text-white'
                      : 'border-border/60 text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] text-text-secondary truncate">{m.name}</span>
                    {m.free && (
                      <span
                        data-testid={`${ALLOWLIST}.freeBadge`}
                        className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium uppercase tracking-wide shrink-0"
                      >
                        Free
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-text-muted/50 truncate block">
                    {m.id}
                    {m.releaseDate ? ` · ${m.releaseDate}` : ''}
                    {m.toolCalling ? ' · tools' : ''}
                    {m.reasoning ? ' · reasoning' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        {error && (
          <div
            data-testid={`${ALLOWLIST}.orphanError`}
            className="px-4 pt-2 text-[11px] text-red-400 leading-relaxed"
          >
            {error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-border/50 flex items-center justify-end gap-2">
          <button
            data-testid={`${ALLOWLIST}.cancel`}
            onClick={onClose}
            className="px-3 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid={`${ALLOWLIST}.save`}
            onClick={() => onSave([...checked])}
            className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Removal copy ─────────────────────────────────────────────────────────────

/** Short verb phrase for the remove affordance, matching what will actually happen. */
function removeActionLabel(kind: ProviderRemoveKind | null): string {
  switch (kind) {
    case 'credential':
      return 'Remove stored credential'
    case 'declaration':
      return 'Remove provider definition'
    case 'both':
      return 'Remove credential and provider definition'
    default:
      return 'Remove provider'
  }
}

/**
 * Confirmation copy that names exactly what is destroyed. Vague destructive
 * prompts are how people lose configuration they cannot get back — the
 * declaration case is unrecoverable from ClaudeUI, so it says so.
 */
function removeConfirmBody(entry: OpencodeProviderCatalogEntry): React.ReactNode {
  const kind = entry.actions.removeKind
  const claim = entry.sharedProviderClaim
  return (
    <>
      {(kind === 'credential' || kind === 'both') && (
        <>
          This deletes <span className="font-medium text-text-primary">{entry.name}</span>&apos;s
          stored credential from opencode&apos;s auth store. You will need to sign in again to use
          it.{' '}
        </>
      )}
      {(kind === 'declaration' || kind === 'both') && (
        <>
          This deletes its provider definition — base URL, model definitions, and options — from
          opencode&apos;s config file. This cannot be undone.{' '}
        </>
      )}
      {claim && (
        <>
          <br />
          <br />
          <span className="text-yellow-400">
            Heads up: the shared provider &quot;{claim.name}&quot; still vends this credential, so
            it will be restored on the next sync. Turn its opencode route off in Common · Providers
            &amp; models to remove it for good.
          </span>
        </>
      )}
    </>
  )
}

// ── Provider configuration dialog ────────────────────────────────────────────

/**
 * The declaration being edited carries two distinct identities:
 *   _key — stable React/testid key; never changes while the dialog is open, so
 *          editing the provider id doesn't remount the field being typed into.
 *   _id  — the EDITABLE opencode provider id (the map key used at save time).
 */
type ProviderRow = OpencodeProviderSettings & { _key: string; _id: string; _managed?: boolean }

/** Empty provider row factory — stable _key, blank editable id. */
function newProvider(): ProviderRow {
  return { _key: crypto.randomUUID(), _id: '', name: '', baseURL: '', models: [] }
}

/**
 * Configure ONE opencode provider, as a dialog stacked over the settings dialog.
 * It is what a row click opens, and what "+ Custom provider" opens empty.
 *
 * FOUR BLOCKS, each gated on what this provider actually is:
 *
 *  1. the declaration form (id / display name / base URL) — only for a provider
 *     ClaudeUI declares or is about to (`entry.actions.canEditDeclaration`, or
 *     the create flow). A catalog provider like `openai` has no declaration, and
 *     offering the form would let a stray keystroke CREATE one;
 *  2. the credential block — status, the relocated OAuth affordance (given by
 *     the pane as `oauthSlot`, since the flow machinery is shared with the
 *     catalog picker), and the API-key field. Gated on `canSetCredential`;
 *  3. the picker allowlist entry point (`onManageModels`), which is ClaudeUI's
 *     own curation and stays available even for a shared-managed provider;
 *  4. the DECLARED model list, each row opening the per-model capability editor
 *     in its stacked frame (OpencodeModelCapabilities.tsx).
 *
 * Edits apply as you type, matching the inline form this replaced. That is
 * deliberate: ModelCapabilityEditor writes capability fields straight to
 * opencode.json via patchOpencodeNative and needs a SAVED provider id + model id
 * to target, so a staged save/cancel here would desync from it.
 *
 * @param providerId Existing provider to configure, or null to declare one.
 */
export function OpencodeProviderConfigModal({
  providerId,
  onClose,
  entry,
  oauthSlot,
  onRemove,
  onManageModels,
  modelsSummary,
  onCredentialChanged
}: {
  providerId: string | null
  onClose: () => void
  /**
   * The catalog entry behind the row that opened this. Absent when the dialog is
   * mounted standalone (the create flow, tests) — which grants the declaration
   * form and the credential block rather than withholding them, because there is
   * no resolved `actions` saying otherwise.
   */
  entry?: OpencodeProviderCatalogEntry
  /** The pane's OAuth connect button + flow UI for this provider, relocated here. */
  oauthSlot?: React.ReactNode
  /** Start the pane's remove confirmation. Absent = removal unavailable. */
  onRemove?: () => void
  /** Open the pane's model-allowlist dialog. Absent = no catalog entry to curate. */
  onManageModels?: () => void
  /** Allowlist summary for the manage affordance, e.g. "3 models". */
  modelsSummary?: string
  /** A credential was written or deleted — the pane re-reads and refreshes models. */
  onCredentialChanged?: () => void
}): React.JSX.Element {
  const [cfg, setCfg] = useState<OpencodeConfigSettings | null>(null)
  const [row, setRow] = useState<ProviderRow | null>(null)
  /** Index of the declared model whose capability editor is open (one at a time). */
  const [capsIdx, setCapsIdx] = useState<number | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [credIds, setCredIds] = useState<Record<string, 'api' | 'oauth'>>({})
  // True when a ClaudeUI shared provider compiles this declaration. Editing it
  // here would be silently overwritten on the shared provider's next sync, so the
  // form is replaced by a pointer to its real owner.
  const [managed, setManaged] = useState(false)

  const reloadCredIds = (): void => {
    window.api
      .vendorAuthListKeys('opencode')
      .then(setCredIds)
      .catch(() => {})
  }

  useEffect(() => {
    Promise.all([
      window.api.loadOpencodeSettings(),
      window.api.listSharedProviders().catch(() => [])
    ])
      .then(([settings, sharedProviders]) => {
        setCfg(settings)
        const managedIds = new Set(
          sharedProviders.map((provider) => provider.routes.opencode.providerId ?? provider.id)
        )
        if (providerId) setManaged(managedIds.has(providerId))
        const existing = providerId ? settings.providers?.[providerId] : undefined
        setRow(
          providerId
            ? {
                _key: providerId,
                _id: providerId,
                name: existing?.name ?? '',
                npm: existing?.npm,
                baseURL: existing?.baseURL ?? '',
                models: existing?.models ?? []
              }
            : newProvider()
        )
      })
      .catch(() => {
        setCfg({})
        setRow(newProvider())
      })
    reloadCredIds()
  }, [providerId])

  /**
   * Splice this one declaration into the FULL providers record.
   *
   * Reading the whole record and replacing only our key matters: the old editor
   * rebuilt the entire record from its own row list, so any declaration it had
   * not loaded would have been dropped. A rename deletes the previous key, which
   * the ADR-031 writer turns into `delete ['provider', oldId]` — user intent.
   */
  const persist = (next: ProviderRow): void => {
    if (!cfg) return
    const providers: Record<string, OpencodeProviderSettings> = { ...(cfg.providers ?? {}) }
    if (next._key && next._key !== next._id) delete providers[next._key]

    const nextId = next._id.trim()
    if (nextId) {
      const models = (next.models ?? [])
        .filter((m) => m.id.trim())
        .map((m) =>
          m.name?.trim() ? { id: m.id.trim(), name: m.name.trim() } : { id: m.id.trim() }
        )
      const declaration: OpencodeProviderSettings = {}
      if (next.name) declaration.name = next.name
      if (next.npm) declaration.npm = next.npm
      if (next.baseURL) declaration.baseURL = next.baseURL
      if (models.length > 0) declaration.models = models
      providers[nextId] = declaration
    }

    const updated: OpencodeConfigSettings = {
      ...cfg,
      providers: Object.keys(providers).length > 0 ? providers : undefined
    }
    setCfg(updated)
    window.api.saveOpencodeSettings(updated).catch(() => {})
    useSessionStore.getState().reloadModels()
  }

  const update = (patch: Partial<ProviderRow>): void => {
    setRow((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      persist(next)
      return next
    })
  }

  // Model-list edits mirror the old inline editor's semantics exactly. Adding
  // stages an empty row without saving — persist() skips blank model ids anyway.
  const addModel = (): void =>
    setRow((prev) => (prev ? { ...prev, models: [...(prev.models ?? []), { id: '' }] } : prev))

  const updateModel = (idx: number, patch: { id?: string; name?: string }): void =>
    update({ models: (row?.models ?? []).map((m, i) => (i === idx ? { ...m, ...patch } : m)) })

  const removeModel = (idx: number): void => {
    setCapsIdx(null)
    update({ models: (row?.models ?? []).filter((_, i) => i !== idx) })
  }

  const id = (row?._id ?? '').trim()
  const credKind = id.length > 0 ? credIds[id] : undefined
  const hasKey = credKind !== undefined

  const saveKey = async (): Promise<void> => {
    const key = apiKey.trim()
    if (!key || !id) return
    setKeyBusy(true)
    setKeyError(null)
    try {
      await window.api.vendorAuthSetKey('opencode', id, key)
      setApiKey('')
      reloadCredIds()
      onCredentialChanged?.()
    } catch {
      setKeyError('Failed to save key.')
    } finally {
      setKeyBusy(false)
    }
  }

  const removeKey = async (): Promise<void> => {
    if (!id) return
    setKeyBusy(true)
    setKeyError(null)
    try {
      await window.api.vendorAuthRemove('opencode', id)
      reloadCredIds()
      onCredentialChanged?.()
    } catch {
      setKeyError('Failed to remove key.')
    } finally {
      setKeyBusy(false)
    }
  }

  // Absent `entry` = mounted standalone; nothing has said these are unavailable.
  const canEditDeclaration = entry ? entry.actions.canEditDeclaration : true
  const canSetCredential = entry ? entry.actions.canSetCredential : true
  const claim = entry?.sharedProviderClaim
  const showDeclaration = providerId === null || canEditDeclaration
  const declaredModels = row?.models ?? []
  const capsModelId = capsIdx === null ? '' : (declaredModels[capsIdx]?.id ?? '').trim()
  // `||`, not `??`: an undeclared display name is '' rather than absent.
  const title = providerId ? entry?.name || row?.name || providerId : 'Add custom provider'

  const modelsBlock = onManageModels ? (
    <>
      <BlockHeader
        label="Models in the picker"
        note="ClaudeUI allowlist"
        actionLabel={`Manage list…${modelsSummary ? ` (${modelsSummary})` : ''}`}
        actionTestid={`${DIALOG}.manageModels`}
        onAction={onManageModels}
      />
      <div className="px-3 pb-1 text-[10px] text-text-muted/60 leading-relaxed">
        Which of this provider&apos;s catalog models appear in ClaudeUI&apos;s model picker. It does
        not change what opencode itself can reach.
      </div>
    </>
  ) : null

  return (
    <>
      <DialogShell
        testid={DIALOG}
        dataId={providerId ?? ''}
        title={title}
        subtitle={
          showDeclaration
            ? 'OpenAI-compatible endpoint. Saved as you edit; applies on each working directory’s next opencode server start.'
            : 'Credentials live in opencode’s own auth store; model curation is ClaudeUI’s. Saved as you edit.'
        }
        onClose={onClose}
        footer={
          <>
            {onRemove ? (
              <button
                type="button"
                data-testid={`${DIALOG}.remove`}
                onClick={onRemove}
                className="px-2 py-1 text-[11px] rounded text-text-muted/70 hover:text-red-400 hover:bg-bg-hover transition-colors"
              >
                {removeActionLabel(entry?.actions.removeKind ?? null)}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              data-testid={`${DIALOG}.done`}
              onClick={onClose}
              className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
            >
              Done
            </button>
          </>
        }
      >
        {row === null ? (
          <div className="px-3 py-1.5 text-[11px] text-text-muted/60">Loading…</div>
        ) : managed ? (
          <>
            <div
              data-testid={`${DIALOG}.managed`}
              className="px-4 py-3 space-y-1.5 text-[11px] leading-relaxed"
            >
              <div className="text-text-primary font-medium">
                {row.name || row._id} is managed by a shared provider.
              </div>
              <div className="text-text-muted/70">
                Its definition and credential are compiled from ClaudeUI&apos;s shared provider, so
                edits made here would be overwritten on the next sync. Change it where it is owned.
              </div>
              <button
                data-testid={`${DIALOG}.openShared`}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('open-settings', {
                      detail: { scope: 'common', section: 'shared-providers' }
                    })
                  )
                }
                className="text-accent hover:text-accent/80 transition-colors"
              >
                Open shared provider
              </button>
            </div>
            {modelsBlock}
          </>
        ) : (
          <>
            {showDeclaration && (
              <>
                <LeafRow
                  testidPrefix={DIALOG}
                  configKey="id"
                  label="Provider id"
                  helper="Its models read <id>/<model id> —"
                  keyText="provider.<id>"
                  error={null}
                >
                  <input
                    type="text"
                    data-testid={`${DIALOG}.id`}
                    placeholder="my-ollama"
                    value={row._id}
                    spellCheck={false}
                    onChange={(e) => update({ _id: e.target.value })}
                    className={`${inputClass} w-64`}
                  />
                </LeafRow>

                <LeafRow
                  testidPrefix={DIALOG}
                  configKey="name"
                  label="Display name"
                  helper="Shown in the model picker; optional —"
                  keyText="provider.<id>.name"
                  error={null}
                >
                  <input
                    type="text"
                    data-testid={`${DIALOG}.name`}
                    placeholder="My Ollama"
                    value={row.name ?? ''}
                    spellCheck={false}
                    onChange={(e) => update({ name: e.target.value })}
                    className={`${inputClass} w-64`}
                  />
                </LeafRow>

                <LeafRow
                  testidPrefix={DIALOG}
                  configKey="baseURL"
                  label="Base URL"
                  helper="OpenAI-compatible endpoint —"
                  keyText="provider.<id>.baseURL"
                  error={null}
                >
                  <input
                    type="url"
                    data-testid={`${DIALOG}.baseUrl`}
                    placeholder="http://localhost:11434/v1"
                    value={row.baseURL ?? ''}
                    spellCheck={false}
                    onChange={(e) => update({ baseURL: e.target.value })}
                    className={`${inputClass} w-64`}
                  />
                </LeafRow>
              </>
            )}

            {canSetCredential && (
              <StackedRow
                testidPrefix={DIALOG}
                configKey="credential"
                label="Credential"
                helper="Held by opencode in its own auth store, never in ClaudeUI’s config —"
                keyText="auth.json"
                error={keyError}
              >
                <div className="px-3 space-y-1.5">
                  {claim && (
                    <div className="text-[10px] text-yellow-400/90 leading-relaxed">
                      This credential is vended by the shared provider &quot;{claim.name}&quot;. A
                      key set here is replaced on its next sync.
                    </div>
                  )}
                  {oauthSlot}
                  {hasKey ? (
                    <div className="flex items-center gap-1.5">
                      <span
                        data-testid={`${DIALOG}.keyStatus`}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400"
                      >
                        {credKind === 'oauth' ? 'Connected' : 'Key set'}
                      </span>
                      <button
                        data-testid={`${DIALOG}.removeKey`}
                        onClick={() => void removeKey()}
                        disabled={keyBusy}
                        className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors disabled:opacity-40"
                      >
                        {keyBusy ? 'Removing…' : credKind === 'oauth' ? 'Disconnect' : 'Remove key'}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="password"
                        data-testid={`${DIALOG}.apiKey`}
                        placeholder="API key"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className={`${inputClass} flex-1`}
                      />
                      <button
                        data-testid={`${DIALOG}.saveKey`}
                        onClick={() => void saveKey()}
                        disabled={keyBusy || !id || !apiKey.trim()}
                        className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {keyBusy ? 'Saving…' : 'Save key'}
                      </button>
                    </div>
                  )}
                </div>
              </StackedRow>
            )}

            {modelsBlock}

            {showDeclaration && (
              <>
                <BlockHeader
                  label="Declared models"
                  note="provider.<id>.models"
                  actionLabel="+ Add model"
                  actionTestid={`${DIALOG}.addModel`}
                  onAction={addModel}
                />
                {declaredModels.length === 0 && (
                  <div
                    data-testid={`${DIALOG}.noModels`}
                    className="px-3 py-1 text-[10px] text-text-muted/60 leading-relaxed"
                  >
                    None declared. A custom endpoint needs at least one model before opencode can
                    offer it.
                  </div>
                )}
                {declaredModels.map((m, idx) => {
                  const modelId = m.id.trim()
                  const capKey = `${row._key}/${idx}`
                  const canEditCaps = id.length > 0 && modelId.length > 0
                  return (
                    <div
                      key={idx}
                      data-testid={`${DIALOG}.modelRow`}
                      data-id={capKey}
                      className="mx-3 mb-1.5 flex items-center gap-1.5 rounded-md border border-border/30 px-2 py-1.5"
                    >
                      <input
                        type="text"
                        placeholder="Model id (e.g. llama3.2)"
                        value={m.id}
                        spellCheck={false}
                        onChange={(e) => updateModel(idx, { id: e.target.value })}
                        className={`${inputClass} flex-1 min-w-0`}
                      />
                      <input
                        type="text"
                        placeholder="Display name"
                        value={m.name ?? ''}
                        spellCheck={false}
                        onChange={(e) => updateModel(idx, { name: e.target.value })}
                        className={`${inputClass} flex-1 min-w-0`}
                      />
                      <button
                        type="button"
                        data-testid={`${DIALOG}.toggleCaps`}
                        data-id={capKey}
                        disabled={!canEditCaps}
                        title={
                          canEditCaps
                            ? 'Edit this model’s capabilities'
                            : 'Set a provider id and model id to edit capabilities.'
                        }
                        onClick={() => setCapsIdx(idx)}
                        className="shrink-0 text-[10px] text-accent hover:text-accent/80 disabled:text-text-muted/40 disabled:cursor-not-allowed transition-colors"
                      >
                        Capabilities
                      </button>
                      <button
                        type="button"
                        data-testid={`${DIALOG}.removeModel`}
                        data-id={capKey}
                        onClick={() => removeModel(idx)}
                        className="shrink-0 text-[10px] text-text-muted/60 hover:text-red-400 transition-colors px-1"
                        title="Remove model"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
      </DialogShell>

      {capsIdx !== null && id.length > 0 && capsModelId.length > 0 && (
        <ModelCapabilityEditor
          providerId={id}
          modelId={capsModelId}
          onClose={() => setCapsIdx(null)}
          onRemove={() => removeModel(capsIdx)}
        />
      )}
    </>
  )
}

// ── The pane ─────────────────────────────────────────────────────────────────

/**
 * opencode provider manager — the catalog-driven add/auth/curate experience.
 *
 * Surfaces the FULL provider catalog (~146 providers, incl. ones with no custom
 * auth loader like openrouter) so users can ADD any supported provider, authenticate
 * it (OAuth or plain API key), and then pick which of its models appear in the
 * picker (per-provider allowlist). Replaces the old narrow vendor-auth list that
 * only showed providers from /provider/auth ∪ /config/providers.
 */
export function VendorOpencodeSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  const [catalog, setCatalog] = useState<OpencodeProviderCatalogEntry[] | null>(null)
  /** Non-null when the catalog read REJECTED — see the module header's three states. */
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [opencodeCfg, setOpencodeCfg] = useState<OpencodeConfigSettings | null>(null)
  const [options, setOptions] = useState<Record<string, VendorAuthOption[]>>({})
  /** Credential KIND per provider, from opencode's auth store — drives the row badge. */
  const [credIds, setCredIds] = useState<Record<string, 'api' | 'oauth'>>({})
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [oauthFlow, setOauthFlow] = useState<VendorOAuthFlowState>({ stage: 'idle' })
  const [oauthCode, setOauthCode] = useState('')
  const [oauthError, setOauthError] = useState<string | null>(null)
  // Add-provider picker state.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  // Provider currently mid-add (auth UI expanded inline in the picker).
  const [addingId, setAddingId] = useState<string | null>(null)
  // Provider whose model-allowlist dialog is open.
  const [modelDialogId, setModelDialogId] = useState<string | null>(null)
  // Provider being configured: a provider id, or '' for a new declaration
  // (null = closed). '' is distinguishable from a real id, which is never blank.
  const [configId, setConfigId] = useState<string | null>(null)
  // Provider awaiting remove confirmation, with the resolved kind so the dialog
  // can name exactly what it will destroy.
  const [removeTarget, setRemoveTarget] = useState<OpencodeProviderCatalogEntry | null>(null)
  // Orphan guard (see `findModelReferences`): the last edit refused because it
  // would have deleted a model some setting still names. Cleared on the next
  // successful edit; the allowlist dialog gets its own copy so the message lands
  // where the edit was attempted.
  const [orphanError, setOrphanError] = useState<string | null>(null)
  const [allowlistOrphanError, setAllowlistOrphanError] = useState<string | null>(null)
  // opencode's DISCOVERED models — the set an edit can make disappear. Loaded
  // here (not read from the store) so the guard does not depend on whether a
  // chat surface has populated `availableModels` yet.
  const [opencodeModels, setOpencodeModels] = useState<ModelInfo[]>([])
  // Every engine's ClaudeUI config, so a reference from ANOTHER engine (claude's
  // cross-engine `dispatch.defaultModel` names opencode models) is caught too.
  const [engineConfigs, setEngineConfigs] = useState<Partial<Record<EngineId, EngineConfig>>>({})
  const mountedRef = useRef(true)
  const { vendorOAuth, authorizeVendorOAuth, cancelVendorOAuth, submitVendorOAuthCode } =
    useSessionStore(
      useShallow((s) => ({
        vendorOAuth: s.vendorOAuth,
        authorizeVendorOAuth: s.authorizeVendorOAuth,
        cancelVendorOAuth: s.cancelVendorOAuth,
        submitVendorOAuthCode: s.submitVendorOAuthCode
      }))
    )
  // Web drives ADR-057's paste-back flow off `vendorOAuth`; desktop keeps the
  // local `oauthFlow` machinery below, untouched.
  const isWeb = window.api.platform === 'web'
  const [pasteBusy, setPasteBusy] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reload = (): void => {
    Promise.all([
      // The ONE read whose failure is not swallowed into an empty list: an
      // unreachable catalog must not read as "you have no providers".
      window.api.getOpencodeProviders().then(
        (cat) => ({ ok: true as const, cat }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
      ),
      window.api.loadOpencodeSettings().catch(() => ({}) as OpencodeConfigSettings),
      window.api.vendorAuthListOptions('opencode').catch(() => ({})) as Promise<
        Record<string, VendorAuthOption[]>
      >,
      window.api.vendorAuthListKeys('opencode').catch(() => ({}))
    ]).then(([cat, settings, opts, keys]) => {
      if (!mountedRef.current) return
      if (cat.ok) {
        setCatalog(cat.cat)
        setCatalogError(null)
      } else {
        setCatalogError(cat.error)
      }
      setOpencodeCfg(settings)
      setOptions(opts)
      setCredIds(keys)
    })
    window.api
      .getEngineModels()
      .then((groups) => {
        if (!mountedRef.current) return
        setOpencodeModels(groups.filter((g) => g.engineId === 'opencode').flatMap((g) => g.models))
      })
      .catch(() => {})
    Promise.all(
      (Object.keys(ENGINE_META) as EngineId[]).map(async (id) => {
        const cfg = await window.api.loadEngineConfig(id).catch(() => ({}) as EngineConfig)
        return [id, cfg] as const
      })
    ).then((entries) => {
      if (!mountedRef.current) return
      setEngineConfigs(Object.fromEntries(entries))
    })
  }

  useEffect(() => {
    reload()
  }, [])

  const cfg = opencodeCfg ?? {}
  const disabled = cfg.disabledProviders ?? []
  const allowlist = cfg.modelAllowlist ?? {}

  /** Merge a patch into opencode settings, persist, and refresh the picker model list. */
  const updateCfg = (patch: Partial<OpencodeConfigSettings>): OpencodeConfigSettings => {
    const next: OpencodeConfigSettings = { ...cfg, ...patch }
    setOpencodeCfg(next)
    window.api.saveOpencodeSettings(next).catch(() => {})
    useSessionStore.getState().reloadModels()
    return next
  }

  // A provider belongs in the list when it is usable now (authenticated/free)
  // OR explicitly disabled.
  //
  // Disabled providers are INCLUDED deliberately. They used to be filtered out
  // here and re-offered only in the "Add provider" picker, which made a disabled
  // provider look identical to one that was never set up — and hid the fact that
  // opencode was ignoring it. Disable is reversible state, so it must be visible
  // and toggleable in place, which is the whole point of separating it from
  // removal. Discovery supplies these entries (GET /provider omits disabled ids
  // entirely, so their name/modelCount are re-synthesized there).
  const listedProviders = (catalog ?? []).filter(
    (p) => p.authState === 'authenticated' || p.authState === 'free' || p.disabled
  )
  const activeIds = new Set(listedProviders.map((p) => p.id))
  const addable = (catalog ?? [])
    .filter((p) => !activeIds.has(p.id))
    .filter((p) => {
      const q = addSearch.trim().toLowerCase()
      if (!q) return true
      return p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    })

  const allowlistLabel = (id: string): string => {
    const a = allowlist[id]
    if (a === undefined) return 'all models'
    return `${a.length} model${a.length === 1 ? '' : 's'}`
  }

  /** Every discovered opencode model VALUE this provider contributes. */
  const modelsOfProvider = (providerId: string): string[] =>
    opencodeModels.filter((m) => m.vendorId === providerId).map((m) => m.value)

  /**
   * The orphan guard: `null` when the removal is safe, otherwise the message to
   * show INSTEAD of applying it. Refusing beats applying-and-warning — after the
   * write the reference is already broken, and the config that named it is a
   * different dialog away.
   */
  const blockingReferences = (removedValues: string[]): string | null => {
    const refs = findModelReferences({ opencode: cfg, engines: engineConfigs }, removedValues)
    return refs.length > 0 ? formatModelReferences(refs) : null
  }

  // Finalize adding a provider: clear it from disabledProviders, seed an empty
  // model allowlist (so it doesn't flood the picker), close the picker, and open
  // the model dialog so the user curates its models.
  const finishAdd = (id: string): void => {
    const nextDisabled = disabled.filter((d) => d !== id)
    updateCfg({
      disabledProviders: nextDisabled.length > 0 ? nextDisabled : undefined,
      modelAllowlist: { ...allowlist, [id]: allowlist[id] ?? [] }
    })
    setAddingId(null)
    setPickerOpen(false)
    setApiKeys((prev) => ({ ...prev, [id]: '' }))
    reload()
    setModelDialogId(id)
  }

  const handleSaveKey = async (vendorId: string): Promise<void> => {
    const key = (apiKeys[vendorId] ?? '').trim()
    if (!key) return
    setSaving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.vendorAuthSetKey('opencode', vendorId, key)
      finishAdd(vendorId)
    } catch {
      setOauthError(`Failed to save key for ${vendorId}`)
    } finally {
      if (mountedRef.current) setSaving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  /**
   * Toggle opencode's `disabled_providers` veto — reversible, destroys nothing.
   *
   * Goes through the main-process owner rather than writing the array here: it is
   * the same config key removal has to clean up, and having two writers for it is
   * how the original bug (a veto outliving what it vetoed) became possible.
   */
  const handleToggleDisabled = async (vendorId: string, nextDisabled: boolean): Promise<void> => {
    // Disabling hides every model this provider contributes — refuse while one
    // of them is still named by a setting.
    if (nextDisabled) {
      const blocked = blockingReferences(modelsOfProvider(vendorId))
      if (blocked) {
        setOrphanError(blocked)
        return
      }
    }
    setOrphanError(null)
    setRemoving((prev) => ({ ...prev, [vendorId]: true }))
    try {
      await window.api.setOpencodeProviderDisabled(vendorId, nextDisabled)
      // Re-read opencode's config so the row reflects the write, not our guess.
      const settings = await window.api.loadOpencodeSettings().catch(() => null)
      if (settings && mountedRef.current) setOpencodeCfg(settings)
      useSessionStore.getState().reloadModels()
      reload()
    } finally {
      if (mountedRef.current) setRemoving((prev) => ({ ...prev, [vendorId]: false }))
    }
  }

  /**
   * Destroy what ClaudeUI owns for this provider. `kind` comes from the entry's
   * resolved actions and is passed through untouched — widening it here would
   * delete something the confirmation never mentioned.
   */
  const handleRemove = async (entry: OpencodeProviderCatalogEntry): Promise<void> => {
    if (!entry.actions.removeKind) return
    // Throwing (rather than a section-level banner) is deliberate: ConfirmModal
    // keeps itself open and renders the reason under "Could not remove", which is
    // exactly where the user is looking.
    const blocked = blockingReferences(modelsOfProvider(entry.id))
    if (blocked) throw new Error(blocked)
    await window.api.removeOpencodeProvider(entry.id, entry.actions.removeKind)
    const settings = await window.api.loadOpencodeSettings().catch(() => null)
    if (settings && mountedRef.current) setOpencodeCfg(settings)
    useSessionStore.getState().reloadModels()
    reload()
  }

  const handleOAuthStart = async (vendorId: string): Promise<void> => {
    setOauthError(null)
    try {
      const result = await authorizeVendorOAuth('opencode', vendorId)
      if (result.ok) {
        finishAdd(vendorId)
        return
      }
      // Web: the store has already parked the flow — `paste` (the two-step
      // form below) or `error` (opencode's remote-`auto` refusal, rendered as
      // the desktop-only outcome). Nothing local to set.
      if (isWeb) return
      if (result.needsPaste) {
        setOauthFlow({
          stage: 'instructions',
          url: result.needsPaste.url,
          instructions: result.needsPaste.instructions,
          method: result.needsPaste.method,
          vendorId
        })
      }
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Failed to start OAuth flow')
    }
  }

  /** Step 2 of the remote flow — see `submitVendorOAuthCode` in the store. */
  const handlePasteBackSubmit = (vendorId: string, pasted: string): void => {
    setPasteBusy(true)
    void submitVendorOAuthCode(pasted)
      .then((result) => {
        if (result.ok) finishAdd(vendorId)
      })
      .finally(() => {
        if (mountedRef.current) setPasteBusy(false)
      })
  }

  const handleOAuthSubmit = async (): Promise<void> => {
    if (oauthFlow.stage !== 'instructions') return
    const { vendorId, method } = oauthFlow
    const code = oauthCode.trim()
    if (!code) return
    setOauthFlow({ stage: 'submitting', vendorId })
    try {
      await window.api.vendorAuthOauthCallback('opencode', vendorId, method, code)
      setOauthFlow({ stage: 'idle' })
      setOauthCode('')
      finishAdd(vendorId)
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'OAuth callback failed')
      setOauthFlow({ stage: 'idle' })
    }
  }

  /**
   * Every in-flight OAuth stage for ONE vendor: the store-driven web stages
   * (ADR-057 — waiting / outcome / paste-back) and the desktop-local instruction
   * form. A render function, not a component: the catalog picker and the config
   * dialog's credential block both need it, and a nested component would remount
   * (losing the code field) on every keystroke.
   */
  const renderOAuthFlow = (vendorId: string): React.ReactNode => (
    <>
      {vendorOAuth?.vendorId === vendorId && vendorOAuth.stage === 'waiting' && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-text-muted/80">Waiting for browser authorization…</span>
          <button
            onClick={() => cancelVendorOAuth()}
            className="px-2 py-0.5 text-[10px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
      {vendorOAuth?.vendorId === vendorId &&
        vendorOAuth.stage === 'error' &&
        (vendorOAuth.error ? (
          // ADR-057 outcome: the remote-`auto` refusal reads as
          // "use the desktop", a CSRF mismatch as "start again".
          <OAuthOutcomeNotice
            kind={classifyOAuthError(vendorOAuth.error)}
            message={vendorOAuth.error}
            id={vendorId}
          />
        ) : (
          <div className="text-[10px] text-red-400">Authentication failed. Try again.</div>
        ))}

      {/* Remote two-step flow. Never reached on desktop — the store only parks
          `paste` for a web caller. */}
      {vendorOAuth?.vendorId === vendorId && vendorOAuth.stage === 'paste' && (
        <OAuthPasteBackFlow
          variant="url"
          id={vendorId}
          url={vendorOAuth.url}
          busy={pasteBusy}
          onSubmit={(pasted) => handlePasteBackSubmit(vendorId, pasted)}
          onCancel={cancelVendorOAuth}
        />
      )}

      {oauthFlow.stage === 'instructions' && oauthFlow.vendorId === vendorId && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-muted/70 leading-relaxed whitespace-pre-wrap">
            {oauthFlow.instructions}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              placeholder="Paste code here"
              value={oauthCode}
              onChange={(e) => setOauthCode(e.target.value)}
              className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
            />
            <button
              onClick={() => void handleOAuthSubmit()}
              disabled={!oauthCode.trim()}
              className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Submit
            </button>
            <button
              onClick={() => {
                void window.api.vendorAuthOauthCancel('opencode').catch(() => {})
                setOauthFlow({ stage: 'idle' })
                setOauthCode('')
              }}
              className="px-2 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {oauthFlow.stage === 'submitting' && oauthFlow.vendorId === vendorId && (
        <div className="text-[10px] text-text-muted/60">Submitting code…</div>
      )}
    </>
  )

  /** The connect affordance + its flow, for the config dialog's credential block. */
  const oauthSlotFor = (p: OpencodeProviderCatalogEntry): React.ReactNode => {
    const rowOauth = (options[p.id] ?? []).filter((o) => o.type === 'oauth')
    if (!(p.authMethods.includes('oauth') && rowOauth.length > 0)) return null
    return (
      <div className="space-y-1.5">
        <button
          data-testid={`${PANE}.credentialOauth`}
          data-id={p.id}
          onClick={() => void handleOAuthStart(p.id)}
          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
        >
          {rowOauth[0]?.label ?? 'Sign in with OAuth'}
        </button>
        {renderOAuthFlow(p.id)}
      </div>
    )
  }

  if (installed === null) {
    return (
      <div data-testid={PANE} className="px-3 py-1.5 text-[11px] text-text-muted/60">
        Loading…
      </div>
    )
  }
  if (!installed) {
    return (
      <div
        data-testid={PANE}
        className="px-3 py-1.5 text-[11px] text-text-muted/60 leading-relaxed"
      >
        opencode is not installed. Install it to add providers and authenticate them.
      </div>
    )
  }
  // The catalog comes from the opencode server, which `acquire()` may still be
  // spawning — say so rather than showing an empty list that reads as "none".
  if (catalog === null && catalogError === null) {
    return (
      <div data-testid={PANE} className="px-3 py-1.5 text-[11px] leading-relaxed">
        <div data-testid={`${PANE}.booting`} className="text-text-secondary">
          Starting the opencode server…
        </div>
        <div className="text-text-muted/60">
          The provider catalog is read from the running server; a cold start can take a few seconds.
        </div>
      </div>
    )
  }

  const entries = catalog ?? []
  // A rejected read, or a catalog with nothing in it at all. opencode ships ~146
  // providers, so an empty one means the server never answered — never that the
  // user has none.
  const catalogUnavailable = catalogError !== null || entries.length === 0
  const dialogProvider = modelDialogId
    ? (entries.find((p) => p.id === modelDialogId) ?? null)
    : null
  const configEntry =
    configId !== null && configId !== '' ? entries.find((p) => p.id === configId) : undefined

  return (
    <div data-testid={PANE} className="py-1.5 text-[13px] text-text-secondary">
      {oauthError && (
        <div className="mx-3 mb-1 text-[11px] text-red-400 leading-relaxed">{oauthError}</div>
      )}
      {orphanError && (
        <div
          data-testid={`${PANE}.orphanError`}
          className="mx-3 mb-1 text-[11px] text-red-400 leading-relaxed"
        >
          {orphanError}
        </div>
      )}

      <BlockHeader
        label="Configured"
        note="authenticated or declared"
        actionLabel="+ Add from catalog"
        actionTestid={`${PANE}.addProvider`}
        onAction={() => {
          setPickerOpen((open) => !open)
          setAddSearch('')
          setAddingId(null)
        }}
        secondary={{
          label: '+ Custom provider',
          testid: `${PANE}.addCustomProvider`,
          onAction: () => setConfigId('')
        }}
      />

      {pickerOpen && (
        <div data-testid={`${PANE}.catalogPicker`} className="mb-1.5">
          <div className="mx-3 my-1 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              data-testid={`${PANE}.catalogSearch`}
              placeholder="Search providers (e.g. openrouter, anthropic, google)…"
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
              className={`${inputClass} flex-1`}
            />
            <button
              data-testid={`${PANE}.catalogClose`}
              onClick={() => {
                setPickerOpen(false)
                setAddingId(null)
              }}
              className="shrink-0 text-[10px] text-text-muted/70 hover:text-text-primary transition-colors"
            >
              Close
            </button>
          </div>
          {/* The picker's results sit under the CONFIGURED header, so they have
              to say what they are: these rows are NOT configured. */}
          <div className="mx-3 mb-1 text-[10px] text-text-muted/60 leading-relaxed">
            Providers opencode supports that are not set up here yet — pick one to authenticate it.
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {addable.length === 0 ? (
              <div className="px-3 py-1 text-[10px] text-text-muted/60">No providers match.</div>
            ) : (
              addable.slice(0, 60).map((p) => {
                const opts = options[p.id] ?? []
                const apiOption = opts.find((o) => o.type === 'api')
                const oauthOptions = opts.filter((o) => o.type === 'oauth')
                const canOauth = p.authMethods.includes('oauth') && oauthOptions.length > 0
                const expanded = addingId === p.id
                return (
                  <div key={p.id} data-testid={`${PANE}.catalogRow`} data-id={p.id}>
                    <EntityRowCard
                      testid={`${PANE}.catalogRow.card`}
                      dataId={p.id}
                      title={p.name}
                      subtitle={`${p.id}${p.modelCount > 0 ? ` · ${p.modelCount} models` : ''}${
                        canOauth ? ' · OAuth' : ''
                      }`}
                      action={expanded ? '−' : 'Add'}
                      onClick={() => setAddingId(expanded ? null : p.id)}
                    />
                    {/* No free-provider branch here any more. A credential-free
                        gateway always carries authState 'free', so it is always in
                        the Configured list above — enabled, or disabled with an
                        Enable action. It can never be an addable row, so the old
                        keyless "Add" path was unreachable. */}
                    {expanded && (
                      <div className="mx-3 mb-1.5 -mt-0.5 px-3 pb-2 pt-1 space-y-1.5 border-l border-border/30">
                        {canOauth && (
                          <button
                            data-testid={`${PANE}.catalogOauth`}
                            data-id={p.id}
                            onClick={() => void handleOAuthStart(p.id)}
                            className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                          >
                            {oauthOptions[0]?.label ?? 'Sign in with OAuth'}
                          </button>
                        )}
                        {/* API key (always offered for non-free providers — the
                            generic /auth path accepts a key even when the provider
                            has no custom auth loader, e.g. openrouter). */}
                        <div className="flex items-center gap-1.5">
                          <input
                            type="password"
                            data-testid={`${PANE}.catalogKey`}
                            data-id={p.id}
                            placeholder={apiOption?.prompts?.[0]?.message ?? 'API key'}
                            value={apiKeys[p.id] ?? ''}
                            onChange={(e) =>
                              setApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))
                            }
                            className={`${inputClass} flex-1`}
                          />
                          <button
                            data-testid={`${PANE}.catalogSave`}
                            data-id={p.id}
                            onClick={() => void handleSaveKey(p.id)}
                            disabled={saving[p.id] || !(apiKeys[p.id] ?? '').trim()}
                            className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {saving[p.id] ? 'Saving…' : 'Add'}
                          </button>
                        </div>
                        {renderOAuthFlow(p.id)}
                      </div>
                    )}
                  </div>
                )
              })
            )}
            {addable.length > 60 && (
              <div className="px-3 py-1 text-[10px] text-text-muted/50">
                {addable.length - 60} more — refine your search.
              </div>
            )}
          </div>
        </div>
      )}

      {catalogUnavailable ? (
        <div
          data-testid={`${PANE}.catalogError`}
          className="mx-3 mb-1.5 rounded-md border border-border/30 px-3 py-2 space-y-1"
        >
          <div className="text-[11px] text-text-secondary">
            Could not read opencode&apos;s provider catalog.
          </div>
          <div className="text-[10px] text-text-muted/70 leading-relaxed">
            {catalogError ??
              'The opencode server returned nothing at all, which means it did not start or is not answering.'}
          </div>
          <button
            data-testid={`${PANE}.retry`}
            onClick={() => {
              setCatalog(null)
              setCatalogError(null)
              reload()
            }}
            className="text-[10px] text-accent hover:text-accent/80 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {listedProviders.length === 0 && !pickerOpen && (
            <div
              data-testid={`${PANE}.noProviders`}
              className="px-3 py-1 text-[10px] text-text-muted/60 leading-relaxed"
            >
              No providers configured yet. Add one from the catalog, or declare a custom
              OpenAI-compatible endpoint.
            </div>
          )}

          {listedProviders.map((p) => {
            const isFree = p.authState === 'free'
            const busy = removing[p.id]
            const claim = p.sharedProviderClaim
            const kind = credIds[p.id]
            return (
              <EntityRowCard
                key={p.id}
                testid={`${PANE}.providerRow`}
                dataId={p.id}
                title={p.name}
                tag={p.id}
                dimmed={p.disabled}
                badges={
                  <>
                    {/* Disabled wins the badge: opencode ignores the provider
                        entirely, so its auth state is not the useful fact. */}
                    {p.disabled ? (
                      <span
                        data-testid={`${PANE}.disabledBadge`}
                        data-id={p.id}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted"
                      >
                        Disabled
                      </span>
                    ) : isFree ? (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                        Free
                      </span>
                    ) : (
                      <span
                        data-testid={`${PANE}.authBadge`}
                        data-id={p.id}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400"
                      >
                        {/* The credential KIND when opencode's auth store knows it;
                            an env var or an externally-configured provider has
                            none, and "Authenticated" is all we can honestly say. */}
                        {kind === 'oauth'
                          ? 'Subscription'
                          : kind === 'api'
                            ? 'API key'
                            : 'Authenticated'}
                      </span>
                    )}
                    {claim && (
                      <span
                        data-testid={`${PANE}.sharedBadge`}
                        data-id={p.id}
                        title={`Credentials are vended by the shared provider "${claim.name}"`}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent"
                      >
                        🔒 Shared · {claim.name}
                      </span>
                    )}
                  </>
                }
                subtitle={
                  // A disabled provider surfaces NO models whatever its allowlist
                  // says, so "showing all models" would be a plain lie — the exact
                  // class of misleading label this rework exists to remove.
                  p.disabled
                    ? 'ignored by opencode while disabled'
                    : `showing ${allowlistLabel(p.id)}${claim ? ' · managed by Shared Providers' : ''}`
                }
                action={
                  p.actions.canSetCredential || p.actions.canEditDeclaration ? 'Edit' : 'View'
                }
                onClick={() => setConfigId(p.id)}
                actions={
                  <div className="shrink-0 flex items-center gap-0.5 opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <IconButton
                      testId={`${PANE}.providerRow.disable`}
                      id={p.id}
                      label={p.disabled ? 'Enable provider' : 'Disable provider (reversible)'}
                      active={!p.disabled}
                      disabled={busy}
                      onClick={() => void handleToggleDisabled(p.id, !p.disabled)}
                    >
                      <PowerIcon />
                    </IconButton>
                    <IconButton
                      testId={`${PANE}.providerRow.remove`}
                      id={p.id}
                      // A greyed trash with no explanation reads as a broken button,
                      // so the blocked reason IS the label here.
                      label={
                        p.actions.canRemove
                          ? removeActionLabel(p.actions.removeKind)
                          : (p.actions.blockedReason ?? 'Cannot be removed')
                      }
                      danger
                      disabled={!p.actions.canRemove || busy}
                      onClick={() => setRemoveTarget(p)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                }
              />
            )
          })}
        </>
      )}

      <div
        data-testid={`${PANE}.footer`}
        className="px-3 pt-2 mt-1 border-t border-border/20 text-[10px] text-text-muted/50 leading-relaxed"
      >
        Credentials are stored in opencode&apos;s own auth.json, never in ClaudeUI&apos;s config.
        Open a provider to change its credential, curate which of its models reach the picker, or
        edit a custom endpoint&apos;s declaration.
      </div>

      {dialogProvider && (
        <ModelAllowlistDialog
          providerId={dialogProvider.id}
          providerName={dialogProvider.name}
          current={allowlist[dialogProvider.id]}
          error={allowlistOrphanError}
          stacked={configId !== null}
          onClose={() => {
            setAllowlistOrphanError(null)
            setModelDialogId(null)
          }}
          onSave={(ids) => {
            // `ids` are BARE model ids; references are stored as picker VALUES.
            const kept = new Set(ids.map((id) => `${dialogProvider.id}/${id}`))
            const blocked = blockingReferences(
              modelsOfProvider(dialogProvider.id).filter((value) => !kept.has(value))
            )
            if (blocked) {
              setAllowlistOrphanError(blocked)
              return
            }
            setAllowlistOrphanError(null)
            updateCfg({ modelAllowlist: { ...allowlist, [dialogProvider.id]: ids } })
            setModelDialogId(null)
            reload()
          }}
        />
      )}

      {configId !== null && (
        <OpencodeProviderConfigModal
          providerId={configId === '' ? null : configId}
          entry={configEntry}
          oauthSlot={configEntry ? oauthSlotFor(configEntry) : undefined}
          onManageModels={configEntry ? () => setModelDialogId(configEntry.id) : undefined}
          modelsSummary={configEntry ? allowlistLabel(configEntry.id) : undefined}
          onRemove={configEntry?.actions.canRemove ? () => setRemoveTarget(configEntry) : undefined}
          onCredentialChanged={() => {
            useSessionStore.getState().reloadModels()
            reload()
          }}
          onClose={() => {
            setConfigId(null)
            reload()
          }}
        />
      )}

      {removeTarget && (
        <ConfirmModal
          testId={`${PANE}.removeConfirm`}
          // Reachable from the row (nothing above it) and from the config dialog
          // (which holds z-[100]), so it takes the ladder's top rung when open.
          stackedAbove={configId !== null}
          title={`Remove ${removeTarget.name}?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          errorTitle="Could not remove"
          detail={removeTarget.id}
          body={removeConfirmBody(removeTarget)}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const target = removeTarget
            await handleRemove(target)
            // Only clear AFTER success — on failure ConfirmModal keeps itself open
            // and shows the error with a Retry, so the dialog must stay mounted.
            if (mountedRef.current) {
              setRemoveTarget(null)
              // Whatever the dialog was configuring no longer exists.
              setConfigId(null)
            }
          }}
        />
      )}
    </div>
  )
}
