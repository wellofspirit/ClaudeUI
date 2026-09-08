/**
 * OpencodeProviders.tsx
 *
 * The per-provider CONFIGURATION DIALOG for opencode
 * (`OpencodeProviderConfigModal`): a provider's declaration (id / display name /
 * base URL), its credential, and its declared models — each opening the
 * per-model capability editor (OpencodeModelCapabilities.tsx).
 *
 * IT NO LONGER HAS A PANE. This file was the whole of Settings › opencode ›
 * Providers: a catalog-driven add/auth/curate section (`VendorOpencodeSection`)
 * plus a model-allowlist dialog. ADR-065 phase 6c retired that section — one
 * provider LIST now fronts all three stores (`ProviderList`), the Manage sheet
 * owns credentials, the reversible disable veto, removal and the picker
 * allowlist (`ProviderSheet`), and the Add sheet owns the catalog picker and
 * its API-key/OAuth panel (`ProviderAddSheet`). What is left here is the one
 * thing none of those re-implement: the DECLARATION and its models. The Manage
 * sheet's "Model overrides ›" opens this dialog on the provider it is showing.
 *
 * WHAT THE DIALOG STILL GATES. Its four blocks are gated on the catalog entry's
 * resolved `actions`, which is why the sheet reads the catalog before opening
 * it: mounted WITHOUT an entry (the create flow, tests) it grants the
 * declaration form and the credential block, and a catalog provider like
 * `openai` has no declaration — offering the form there would let a stray
 * keystroke create one.
 */

import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type {
  OpencodeConfigSettings,
  OpencodeProviderCatalogEntry,
  OpencodeProviderSettings,
  ProviderRemoveKind
} from '../../../../shared/types'
import { inputClass } from './OpencodeSchemaForm'
import { LeafRow, StackedRow } from './OpencodeConfigPanes'
import { BlockHeader, DialogShell } from './provider-editor-shell'
import { ModelCapabilityEditor } from './OpencodeModelCapabilities'

/** Testid namespace (ADR-027 tier 2) for the dialog. */
const DIALOG = 'OpencodeProviderConfigModal'

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
      <div className="px-3 pb-1 text-[12px] text-text-secondary leading-relaxed">
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
          <div className="px-3 py-1.5 text-[12px] text-text-secondary">Loading…</div>
        ) : managed ? (
          <>
            <div
              data-testid={`${DIALOG}.managed`}
              className="px-4 py-3 space-y-1.5 text-[12px] leading-relaxed"
            >
              <div className="text-text-primary font-medium">
                {row.name || row._id} is managed by a shared provider.
              </div>
              <div className="text-text-secondary">
                Its definition and credential are compiled from ClaudeUI&apos;s shared provider, so
                edits made here would be overwritten on the next sync. Change it where it is owned.
              </div>
              <button
                data-testid={`${DIALOG}.openShared`}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('open-settings', {
                      detail: { page: 'models', group: 'providers' }
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
                  helper="Its models read <id>/<model id>."
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
                  helper="Shown in the model picker; optional."
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
                  helper="OpenAI-compatible endpoint."
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
                helper="Held by opencode in its own auth store, never in ClaudeUI’s config."
                keyText="auth.json"
                error={keyError}
              >
                <div className="px-3 space-y-1.5">
                  {claim && (
                    <div className="text-[12px] text-yellow-400/90 leading-relaxed">
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
                        className="text-[11px] text-text-secondary hover:text-danger transition-colors disabled:opacity-40"
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
                    className="px-3 py-1 text-[12px] text-text-secondary leading-relaxed"
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
                        className="shrink-0 text-[11px] text-text-secondary hover:text-danger transition-colors px-1"
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
