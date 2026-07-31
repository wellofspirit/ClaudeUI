import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../../stores/session-store'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderRouteDiagnosis,
  SharedProviderStatus
} from '../../../../shared/shared-provider'

/**
 * Explain an enabled-but-empty route, and say where to fix it. Each string names
 * the cause first so the reason is legible even when truncated.
 */
function routeDiagnosisText(
  harness: ConfigurableHarnessId,
  diagnosis: SharedProviderRouteDiagnosis
): string {
  switch (diagnosis) {
    case 'provider-disabled':
      return `— disabled in ${harness}; enable it under ${harness} · Providers`
    case 'models-restricted':
      return `— every model is filtered out; adjust the allowlist under ${harness} · Providers`
    case 'no-models-discovered':
      return `— ${harness} reported no models; check it is installed and reachable`
  }
}

const harnesses: ConfigurableHarnessId[] = ['pi', 'opencode']
const blank = (): SharedProviderDefinition => ({
  id: '',
  name: '',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: '',
  models: [{ id: '', name: '' }],
  routes: { pi: { enabled: true }, opencode: { enabled: true } },
  managed: true
})

export function SharedProviders(): React.JSX.Element {
  const readOnly = window.api.platform === 'web'
  const [definitions, setDefinitions] = useState<SharedProviderDefinition[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, SharedProviderStatus>>({})
  const [models, setModels] = useState<Record<string, SharedProviderModel[]>>({})
  const [draft, setDraft] = useState<SharedProviderDefinition | null>(null)
  const [key, setKey] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { vendorOAuth, authorizeVendorOAuth, cancelVendorOAuth } = useSessionStore(
    useShallow((s) => ({
      vendorOAuth: s.vendorOAuth,
      authorizeVendorOAuth: s.authorizeVendorOAuth,
      cancelVendorOAuth: s.cancelVendorOAuth
    }))
  )
  const reload = async (): Promise<void> => {
    setError(null)
    try {
      const [next, status] = await Promise.all([
        window.api.listSharedProviders(),
        window.api.getSharedProviderStatuses()
      ])
      const lists = await Promise.all(
        next.map(async (d) => [d.id, await window.api.listSharedProviderModels(d.id)] as const)
      )
      setDefinitions(next)
      setStatuses(Object.fromEntries(status.map((s) => [s.id, s])))
      setModels(Object.fromEntries(lists))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDefinitions((current) => current ?? [])
    }
  }
  useEffect(() => {
    void reload()
  }, [])
  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      await action()
      useSessionStore.getState().reloadModels()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  if (definitions === null)
    return (
      <div data-testid="SharedProviders" className="px-3 py-2 text-[12px] text-text-muted">
        Loading providers...
      </div>
    )
  return (
    <div
      data-testid="SharedProviders"
      className="px-3 py-2 space-y-3 text-[12px] text-text-secondary"
    >
      <div className="flex justify-between items-center">
        <span>
          Shared provider definitions are canonical for pi and opencode.
          {readOnly && ' Open the desktop app to make changes.'}
        </span>
        <button
          data-testid="SharedProviders.refresh"
          onClick={() => void reload()}
          className="text-accent"
        >
          Refresh
        </button>
      </div>
      {error && (
        <div data-testid="SharedProviders.error" className="text-danger">
          {error}
        </div>
      )}
      {definitions.length === 0 && (
        <div data-testid="SharedProviders.empty" className="text-text-muted">
          No shared providers configured.
        </div>
      )}
      {definitions.map((definition) => (
        <ProviderCard
          key={definition.id}
          definition={definition}
          status={statuses[definition.id]}
          models={models[definition.id] ?? []}
          busy={busy !== null}
          readOnly={readOnly}
          oauthBusy={
            vendorOAuth?.engineId === 'pi' &&
            vendorOAuth.vendorId === 'openai-codex' &&
            vendorOAuth.stage === 'waiting'
          }
          onRoute={(h, enabled) =>
            run(definition.id, () => window.api.setSharedProviderRoute(definition.id, h, enabled))
          }
          onDefault={(h, modelId) =>
            run(definition.id, () =>
              window.api.setSharedProviderDefaultModel(definition.id, h, modelId || undefined)
            )
          }
          onSync={() => run(definition.id, () => window.api.syncSharedProvider(definition.id))}
          onDisconnect={() =>
            run(definition.id, () => window.api.disconnectSharedProvider(definition.id))
          }
          onConnect={() =>
            void authorizeVendorOAuth('pi', 'openai-codex')
              .then((result) => {
                if (!result.ok) throw new Error('Failed to start the ChatGPT connect flow')
                return reload()
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }
          onCancel={cancelVendorOAuth}
          onEdit={() => {
            setDraft(definition)
            setEditingId(definition.id)
            setKey('')
          }}
          onDelete={() => {
            if (confirm(`Delete ${definition.name}?`))
              void run(definition.id, () => window.api.removeSharedProvider(definition.id))
          }}
        />
      ))}
      {draft ? (
        <ProviderForm
          draft={draft}
          apiKey={key}
          onKey={setKey}
          onChange={setDraft}
          idLocked={editingId !== null}
          onCancel={() => {
            setDraft(null)
            setEditingId(null)
            setKey('')
          }}
          onSave={() =>
            void run(draft.id || 'new', async () => {
              if (!draft.id || !draft.name || draft.models.some((m) => !m.id))
                throw new Error('Provider id, name, and model id are required')
              const normalized: SharedProviderDefinition = {
                ...draft,
                id: draft.id.trim(),
                name: draft.name.trim(),
                baseUrl: draft.baseUrl?.trim(),
                models: draft.models.map((model) => {
                  const name = model.name?.trim()
                  return { ...model, id: model.id.trim(), name: name || undefined }
                })
              }
              await window.api.saveSharedProvider(normalized)
              if (key) await window.api.setSharedProviderApiKey(normalized.id, key)
              setDraft(null)
              setEditingId(null)
              setKey('')
            })
          }
        />
      ) : readOnly ? null : (
        <button
          data-testid="SharedProviders.create"
          onClick={() => {
            setDraft(blank())
            setEditingId(null)
            setKey('')
          }}
          className="px-2 py-1 rounded bg-accent/15 text-accent"
        >
          Add custom provider
        </button>
      )}
    </div>
  )
}

function ProviderCard({
  definition,
  status,
  models,
  busy,
  readOnly,
  oauthBusy,
  onRoute,
  onDefault,
  onSync,
  onDisconnect,
  onConnect,
  onCancel,
  onEdit,
  onDelete
}: {
  definition: SharedProviderDefinition
  status?: SharedProviderStatus
  models: SharedProviderModel[]
  busy: boolean
  readOnly: boolean
  oauthBusy: boolean
  onRoute: (h: ConfigurableHarnessId, enabled: boolean) => void
  onDefault: (h: ConfigurableHarnessId, id: string) => void
  onSync: () => void
  onDisconnect: () => void
  onConnect: () => void
  onCancel: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="SharedProviderCard"
      data-id={definition.id}
      className="border border-border/40 rounded-md p-2.5 space-y-2"
    >
      <div className="flex justify-between gap-2">
        <div>
          <b className="text-[13px] text-text-primary">{definition.name}</b>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
            <code>{definition.id}</code>
            <span
              className={`rounded-full px-1.5 py-0.5 ${status?.connected ? 'bg-green-500/10 text-green-400' : 'bg-white/5'}`}
            >
              {status?.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="SharedProviderCard.sync"
            disabled={busy || readOnly}
            onClick={onSync}
            className="rounded px-1.5 py-0.5 text-accent hover:bg-accent/10"
          >
            Sync
          </button>
          {definition.kind === 'custom' && (
            <>
              <button
                data-testid="SharedProviderCard.edit"
                disabled={busy || readOnly}
                onClick={onEdit}
                className="rounded px-1.5 py-0.5 hover:bg-bg-hover"
              >
                Edit
              </button>
              <button
                data-testid="SharedProviderCard.delete"
                disabled={busy || readOnly}
                onClick={onDelete}
                className="rounded px-1.5 py-0.5 text-danger hover:bg-red-500/10"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {definition.id === 'chatgpt' && (
        <div className="flex gap-2 items-center">
          {status?.connected ? (
            <button
              data-testid="SharedProviderCard.disconnect"
              disabled={busy || readOnly}
              onClick={onDisconnect}
              className="rounded bg-white/5 px-2 py-1 text-text-muted hover:text-red-400"
            >
              Disconnect ChatGPT
            </button>
          ) : (
            <>
              <button
                data-testid="SharedProviderCard.connect"
                disabled={busy || oauthBusy || readOnly}
                onClick={onConnect}
                className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-40"
              >
                {window.api.platform === 'web'
                  ? 'Connect from the desktop app'
                  : oauthBusy
                    ? 'Connecting...'
                    : 'Connect ChatGPT'}
              </button>
              {oauthBusy && <button onClick={onCancel}>Cancel</button>}
            </>
          )}
          {status?.connected && <span className="text-success">Central connection</span>}
        </div>
      )}
      {harnesses.map((h) => {
        const route = definition.routes[h]
        const routeStatus = status?.routes[h]
        const available = models.filter(
          (m) =>
            m.harnessOverrides?.[h]?.available !== false &&
            m.harnessOverrides?.[h]?.enabled !== false
        )
        return (
          <div key={h} className="border-t border-border/30 pt-1.5">
            <label className="flex gap-2">
              <input
                data-testid="SharedProviderCard.routeToggle"
                data-harness={h}
                type="checkbox"
                checked={route.enabled}
                disabled={busy || readOnly}
                onChange={(e) => onRoute(h, e.target.checked)}
              />
              Share with {h}{' '}
              <span className="text-[10px] text-text-muted">
                {routeStatus?.error ??
                  `${routeStatus?.delivered ? 'delivered' : 'not delivered'} · ${routeStatus?.modelCount ?? 0} models`}
              </span>
              {/* A bare "0 models" is what made a real failure opaque: the
                  credential was delivered fine, but the engine's own provider veto
                  hid it. Name the cause AND the fix. */}
              {routeStatus?.diagnosis && !routeStatus.error && (
                <span
                  data-testid="SharedProviderCard.routeDiagnosis"
                  data-harness={h}
                  data-diagnosis={routeStatus.diagnosis}
                  className="text-[10px] text-yellow-400/90"
                >
                  {routeDiagnosisText(h, routeStatus.diagnosis)}
                </span>
              )}
            </label>
            {route.enabled && (
              <div className="mt-1">
                <label className="text-[10px] text-text-muted" htmlFor={`${definition.id}-${h}-default`}>
                  Default model for {h}
                </label>
                <select
                  id={`${definition.id}-${h}-default`}
                  data-testid="SharedProviderCard.defaultModel"
                  data-harness={h}
                  disabled={busy || readOnly}
                  aria-label={`${h} default model`}
                  value={route.defaultModel ?? ''}
                  onChange={(e) => onDefault(h, e.target.value)}
                  className="mt-0.5 w-full rounded border border-border/40 bg-bg-input px-2 py-1 text-[11px]"
                >
                  <option value="">No default from this provider</option>
                  {route.defaultModel &&
                    !available.some((model) => model.id === route.defaultModel) && (
                      <option value={route.defaultModel}>{route.defaultModel} (unavailable)</option>
                    )}
                  {available.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
                <div className="mt-0.5 text-[10px] text-text-muted/70">
                  All delivered models remain available unless restricted in {h} model settings.
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ProviderForm({
  draft,
  apiKey,
  onKey,
  onChange,
  onCancel,
  onSave,
  idLocked
}: {
  draft: SharedProviderDefinition
  apiKey: string
  onKey: (v: string) => void
  onChange: (d: SharedProviderDefinition) => void
  onCancel: () => void
  onSave: () => void
  idLocked: boolean
}): React.JSX.Element {
  const set = (patch: Partial<SharedProviderDefinition>): void => onChange({ ...draft, ...patch })
  const setModel = (i: number, patch: Partial<SharedProviderModel>): void =>
    set({ models: draft.models.map((m, n) => (n === i ? { ...m, ...patch } : m)) })
  const fieldClass =
    'w-full rounded border border-border/50 bg-bg-input px-2 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted/50 focus:border-accent/60 disabled:opacity-50'
  return (
    <div
      data-testid="SharedProviderForm"
      className="space-y-3 rounded-md border border-accent/40 bg-accent/[0.03] p-3"
    >
      <div>
        <div className="text-[12px] font-medium text-text-primary">
          {idLocked ? `Edit ${draft.name}` : 'New custom provider'}
        </div>
        <div className="text-[10px] text-text-muted">
          One definition is projected into every enabled harness.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[10px] text-text-muted">
          Provider ID
          <input
            data-testid="SharedProviderForm.id"
            disabled={idLocked}
            value={draft.id}
            placeholder="internal-gateway"
            onChange={(e) => set({ id: e.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="space-y-1 text-[10px] text-text-muted">
          Display name
          <input
            data-testid="SharedProviderForm.name"
            value={draft.name}
            placeholder="Internal gateway"
            onChange={(e) => set({ name: e.target.value })}
            className={fieldClass}
          />
        </label>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-2">
        <label className="space-y-1 text-[10px] text-text-muted">
          Protocol
          <select
            data-testid="SharedProviderForm.protocol"
            value={draft.protocol}
            onChange={(e) =>
              set({ protocol: e.target.value as SharedProviderDefinition['protocol'] })
            }
            className={fieldClass}
          >
            <option value="openai-completions">OpenAI completions</option>
            <option value="openai-responses">OpenAI responses</option>
            <option value="anthropic-messages">Anthropic messages</option>
          </select>
        </label>
        <label className="space-y-1 text-[10px] text-text-muted">
          Base URL
          <input
            data-testid="SharedProviderForm.baseUrl"
            value={draft.baseUrl ?? ''}
            placeholder="https://llm.example/v1"
            onChange={(e) => set({ baseUrl: e.target.value })}
            className={fieldClass}
          />
        </label>
      </div>
      <div className="flex gap-4 rounded border border-border/30 bg-bg-primary/30 px-2 py-1.5">
        {harnesses.map((harness) => (
          <label key={harness} className="flex items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={draft.routes[harness].enabled}
              onChange={(event) =>
                set({
                  routes: {
                    ...draft.routes,
                    [harness]: { ...draft.routes[harness], enabled: event.target.checked }
                  }
                })
              }
            />
            Share with {harness}
          </label>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-text-muted">Models</div>
        {draft.models.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
            <input
              data-testid="SharedProviderForm.modelId"
              value={m.id}
              placeholder="Model ID"
              onChange={(e) => setModel(i, { id: e.target.value })}
              className={fieldClass}
            />
            <input
              value={m.name ?? ''}
              placeholder="Display name (optional)"
              onChange={(e) => setModel(i, { name: e.target.value })}
              className={fieldClass}
            />
            <button
              type="button"
              onClick={() => set({ models: draft.models.filter((_, n) => n !== i) })}
              className="rounded px-2 text-[10px] text-text-muted hover:bg-bg-hover hover:text-red-400"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="SharedProviderForm.addModel"
          onClick={() => set({ models: [...draft.models, { id: '', name: '' }] })}
          className="text-[11px] text-accent"
        >
          + Add model
        </button>
      </div>
      <label className="block space-y-1 text-[10px] text-text-muted">
        API key
        <input
          data-testid="SharedProviderForm.apiKey"
          type="password"
          disabled={window.api.platform === 'web'}
          value={apiKey}
          placeholder={
            window.api.platform === 'web'
              ? 'API keys can only be changed from the desktop app'
              : 'Set or replace API key (optional)'
          }
          onChange={(e) => onKey(e.target.value)}
          className={fieldClass}
        />
      </label>
      <div className="flex justify-end gap-2 border-t border-border/30 pt-2">
        <button onClick={onCancel} className="rounded px-2 py-1 text-text-muted hover:bg-bg-hover">
          Cancel
        </button>
        <button
          data-testid="SharedProviderForm.save"
          onClick={onSave}
          className="rounded bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30"
        >
          Save
        </button>
      </div>
    </div>
  )
}
