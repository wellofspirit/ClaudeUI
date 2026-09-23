/**
 * ProviderAddSheet — "+ Add provider" (ADR-065 § "Providers: one list",
 * settings-v2 phase 6c, board `board2-ProviderAdd.png`).
 *
 * The three provider panes this slice retires each had their own add flow: the
 * shared vault's "Add custom provider" form, opencode's catalog picker with an
 * inline API-key/OAuth panel, and pi's "Add API key" select. They asked the same
 * two questions in three vocabularies, and none of them could say that one
 * credential can serve BOTH engines. This sheet asks those two questions once:
 *
 *   1. WHICH provider — a models.dev catalog entry, a custom OpenAI-compatible
 *      endpoint, or an engine-owned sign-in (sign-in SUBSCRIPTIONS are not
 *      added here: each has its own card, ADR-074 §7);
 *   2. WHICH engines get it — the footer's "Pick one, then choose which engines
 *      get it."
 *
 * THREE STEPS, ONE SHEET (never a stacked dialog): `list` → `setup` (a catalog
 * pick: enable-for chips, then a key or an OAuth sign-in) or `custom` (the
 * endpoint form). Back returns to the list with the search intact.
 *
 * ROWS ARE WHAT THE USER DOES NOT HAVE. The registry snapshot the list renders
 * is the set of providers they DO have, so this sheet is its complement: an
 * opencode catalog entry that is already authenticated is a row over there, not
 * a candidate here, and a pi vendor with a key in `auth.json` likewise. The
 * shared vault owns the ids its ENABLED routes resolve to, so a managed id
 * (ChatGPT's `openai-codex` in pi) is never offered as a bare vendor.
 *
 * WHERE EACH SAVE GOES — every one is an EXISTING writer, as in the Manage
 * sheet; this file introduces no channel of its own:
 *
 *  · engine sign-in (Claude/pi) → nothing: pi's login is a terminal command, so
 *                                 the row COPIES it (`pi:binary-path`)
 *  · catalog, API key         → `shared-provider:save` (a `catalog` definition,
 *                               ADR-074 §6) + ONE `shared-provider:set-key`: the
 *                               key is stored once and delivered to each engine
 *  · catalog, OAuth           → `vendor-auth:oauth-authorize` + `:oauth-callback`
 *  · custom endpoint          → `shared-provider:save` (+ `shared-provider:set-key`)
 *
 * ONE CARRIED-OVER BEHAVIOUR worth naming: adding an opencode provider seeds an
 * EMPTY model allowlist (`VendorOpencodeSection.finishAdd` did the same). A
 * catalog provider can ship 300 models, and letting them all into the picker the
 * moment a key lands is what made the picker unusable; the parent opens the
 * Manage sheet on the new row so curation is the next thing on screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OpencodeProviderCatalogEntry, VendorAuthOption } from '../../../../shared/types'
import type { ProviderRegistrySnapshot } from '../../../../shared/provider-registry'
import {
  validateSharedProviderId,
  type ConfigurableHarnessId,
  type SharedProviderDefinition
} from '../../../../shared/shared-provider'
import { Button, ChipSet, SettingRow, TextField } from './settings-controls'
import { SheetFrame, SheetGroup } from './SheetFrame'
import { LARGE_CATALOG, opencodeCurationAdapter, piCurationAdapter } from './ModelCuration'
import { EngineChip } from './ProviderSheet'
import { ProviderForm, blankProviderDraft, normalizeProviderDraft } from './ProviderForm'
import { VendorOAuthFlow } from './VendorOAuthFlow'

/** Testid namespace (ADR-027 tier 1/2). */
const SHEET = 'ProviderAddSheet'

/** pi's auth.json key for the Codex (ChatGPT) credential — CredentialSync.PI_CODEX_VENDOR_ID. */
const CODEX_VENDOR_ID = 'openai-codex'

/** How many catalog rows render before the "refine your search" line. */
const CATALOG_LIMIT = 60

/** One addable provider: who offers it, and how it can be authenticated. */
interface Candidate {
  id: string
  name: string
  /** The engines that offer this provider — the only ones the setup step lists. */
  engines: ConfigurableHarnessId[]
  /** opencode's own OAuth option, when it has one (its label is the button's). */
  oauthLabel?: string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ProviderAddSheetProps {
  /** What the user already HAS — this sheet offers the complement. */
  snapshot: ProviderRegistrySnapshot
  onClose: () => void
  /**
   * A credential or definition was written. The argument is the registry row id
   * the write should produce, so the parent can re-read and open its Manage
   * sheet; null when nothing identifiable was created.
   */
  onAdded: (registryId: string | null) => void | Promise<void>
}

export function ProviderAddSheet({
  snapshot,
  onClose,
  onAdded
}: ProviderAddSheetProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [step, setStep] = useState<
    { kind: 'list' } | { kind: 'setup'; candidate: Candidate } | { kind: 'custom' }
  >({ kind: 'list' })
  const [catalog, setCatalog] = useState<OpencodeProviderCatalogEntry[]>([])
  const [opencodeOptions, setOpencodeOptions] = useState<Record<string, VendorAuthOption[]>>({})
  const [piOptions, setPiOptions] = useState<Record<string, VendorAuthOption[]>>({})
  const [definitions, setDefinitions] = useState<SharedProviderDefinition[]>([])
  const [piCommand, setPiCommand] = useState<string | null>(null)
  /**
   * Three catalog states, never one (the lesson of `VendorOpencodeSection`'s
   * header): still reading, a REJECTED read, and a resolved catalog. An empty
   * section that says "you already have everything" while the read is in
   * flight — or after it failed — is the failure mode this separates.
   */
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { entries, opencodeInstalled } = snapshot

  useEffect(() => {
    let cancelled = false
    let failed = false
    void Promise.all([
      opencodeInstalled
        ? window.api.getOpencodeProviders().catch((): OpencodeProviderCatalogEntry[] => {
            failed = true
            return []
          })
        : Promise.resolve<OpencodeProviderCatalogEntry[]>([]),
      opencodeInstalled
        ? window.api
            .vendorAuthListOptions('opencode')
            .catch((): Record<string, VendorAuthOption[]> => ({}))
        : Promise.resolve<Record<string, VendorAuthOption[]>>({}),
      window.api.vendorAuthListOptions('pi').catch((): Record<string, VendorAuthOption[]> => ({})),
      window.api.listSharedProviders().catch((): SharedProviderDefinition[] => []),
      window.api.getPiBinaryPath().catch((): string | null => null)
    ]).then(([cat, opencodeOpts, piOpts, defs, piPath]) => {
      if (cancelled) return
      setCatalog(cat)
      setOpencodeOptions(opencodeOpts)
      setPiOptions(piOpts)
      setDefinitions(defs)
      setPiCommand(piPath ? `"${piPath}"` : null)
      setCatalogState(failed ? 'failed' : 'ready')
    })
    return () => {
      cancelled = true
    }
  }, [opencodeInstalled])

  /** The vault owns the native ids its routes resolve to — never offer those. */
  const managed = useMemo(() => {
    const owned = { opencode: new Set<string>(), pi: new Set<string>([CODEX_VENDOR_ID]) }
    for (const definition of definitions) {
      // The definition's own id always (a catalog provider with its routes off
      // is still set up), and the native id each ENABLED route delivers to.
      owned.opencode.add(definition.id)
      owned.pi.add(definition.id)
      if (definition.routes.opencode.enabled)
        owned.opencode.add(definition.routes.opencode.providerId ?? definition.id)
      if (definition.routes.pi.enabled)
        owned.pi.add(definition.routes.pi.providerId ?? definition.id)
    }
    return owned
  }, [definitions])

  /**
   * The catalog: everything the engines OFFER that is not already a row.
   *
   * opencode's own predicate for "configured" is the registry's row filter
   * (`authenticated` / `free` / vetoed), so the complement is exactly its
   * `unauthenticated` entries. pi has no such state — an entry in its auth.json
   * IS the credential — so a pi candidate is a built-in vendor with an API-key
   * option and no row of its own.
   */
  const candidates = useMemo((): Candidate[] => {
    const configuredPi = new Set(
      entries.filter((e) => e.origin === 'pi-native').map((e) => e.id.slice('pi:'.length))
    )
    const byId = new Map<string, Candidate>()
    if (opencodeInstalled) {
      for (const entry of catalog) {
        if (entry.authState !== 'unauthenticated' || entry.disabled) continue
        // A shared definition already names this id — a catalog provider with its
        // routes off, say. Re-adding it here would replace that definition.
        if (managed.opencode.has(entry.id)) continue
        const oauth = (opencodeOptions[entry.id] ?? []).find((o) => o.type === 'oauth')
        byId.set(entry.id, {
          id: entry.id,
          name: entry.name,
          engines: ['opencode'],
          ...(entry.authMethods.includes('oauth') && oauth
            ? { oauthLabel: oauth.label || 'Sign in with OAuth' }
            : {})
        })
      }
    }
    for (const [id, options] of Object.entries(piOptions)) {
      if (configuredPi.has(id) || managed.pi.has(id)) continue
      if (!options.some((o) => o.type === 'api')) continue
      const existing = byId.get(id)
      if (existing) existing.engines = [...existing.engines, 'pi']
      // pi ships no display names — its own discovery reports the id too.
      else byId.set(id, { id, name: id, engines: ['pi'] })
    }
    return [...byId.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    )
  }, [catalog, opencodeOptions, piOptions, entries, managed, opencodeInstalled])

  /** Nothing offers a catalog at all — the section is not rendered empty. */
  const hasCatalogSource = opencodeInstalled || Object.keys(piOptions).length > 0

  const query = search.trim().toLowerCase()
  const matches = (...text: string[]): boolean =>
    !query || text.some((value) => value.toLowerCase().includes(query))
  const shownCandidates = candidates.filter((c) => matches(c.id, c.name))
  const showClaudeForPi = piCommand !== null && matches('claude', 'pro', 'max', 'pi')

  /** Run one write: report a rejection here rather than closing on a failure. */
  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const copyCommand = (): void => {
    if (!piCommand) return
    void navigator.clipboard
      ?.writeText(piCommand)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => setError('Could not write to the clipboard.'))
  }

  // ── Steps ──────────────────────────────────────────────────────────

  const listStep = (
    <>
      <input
        type="text"
        data-testid={`${SHEET}.search`}
        value={search}
        placeholder="Search providers"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setSearch(e.target.value)}
        className="w-full h-8 bg-bg-input border border-border rounded-md px-3 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
      />

      {/* Sign-in SUBSCRIPTIONS are not added here — each has its card under
          Models & providers › Subscriptions (ADR-074 §7). What stays is an
          ENGINE-OWNED sign-in: pi's own Claude login, which pi keeps and runs in
          a terminal, so it belongs with the providers that engine owns. */}
      {showClaudeForPi && (
        <div className="mt-4">
          <SheetGroup testid={`${SHEET}.group`} id="engine-sign-ins" label="Engine sign-ins">
            <SettingRow
              testid={`${SHEET}.engineSignIn`}
              dataId="claude-pi"
              label="Claude Pro / Max for pi"
              description="pi’s OAuth login runs in a terminal. Copies the command."
            >
              <EngineChip engine="pi" enabled testid={`${SHEET}.engineChip`} />
              <Button variant="link" testid={`${SHEET}.copyCommand`} onClick={copyCommand}>
                {copied ? 'Copied' : 'Copy command'}
              </Button>
            </SettingRow>
          </SheetGroup>
        </div>
      )}

      {hasCatalogSource && (
        <div className="mt-4">
          <SheetGroup
            testid={`${SHEET}.group`}
            id="catalog"
            label="Catalog"
            trailing={
              <span
                data-testid={`${SHEET}.catalogTag`}
                className="shrink-0 border border-border rounded-full px-[7px] text-[10.5px] leading-4 text-text-secondary"
              >
                models.dev
              </span>
            }
          >
            {shownCandidates.length === 0 ? (
              <SettingRow
                testid={`${SHEET}.catalogEmpty`}
                dataId={catalogState}
                dimmed={catalogState !== 'failed'}
                description={
                  catalogState === 'loading'
                    ? 'Reading the catalog…'
                    : catalogState === 'failed'
                      ? 'opencode’s provider catalog could not be read — its server did not answer.'
                      : candidates.length === 0
                        ? 'Every provider these engines offer is already set up.'
                        : 'No providers match.'
                }
              />
            ) : (
              shownCandidates.slice(0, CATALOG_LIMIT).map((candidate) => (
                <SettingRow
                  key={candidate.id}
                  as="button"
                  testid={`${SHEET}.catalog`}
                  dataId={candidate.id}
                  label={candidate.name}
                  description={candidate.oauthLabel ? 'API key or OAuth' : 'API key'}
                  onClick={() => setStep({ kind: 'setup', candidate })}
                >
                  {candidate.engines.map((engine) => (
                    <EngineChip
                      key={engine}
                      engine={engine}
                      enabled
                      testid={`${SHEET}.engineChip`}
                    />
                  ))}
                </SettingRow>
              ))
            )}
            {shownCandidates.length > CATALOG_LIMIT && (
              <SettingRow
                testid={`${SHEET}.catalogMore`}
                dimmed
                description={`${shownCandidates.length - CATALOG_LIMIT} more — refine your search.`}
              />
            )}
          </SheetGroup>
        </div>
      )}

      <div className="mt-4">
        <SheetGroup testid={`${SHEET}.group`} id="custom" label="Custom endpoint">
          <SettingRow
            as="button"
            testid={`${SHEET}.custom`}
            label="Add an OpenAI-compatible endpoint"
            description="One definition, delivered to each engine you enable — a local server, a proxy, or a gateway."
            onClick={() => setStep({ kind: 'custom' })}
          >
            <span className="text-[12px] text-accent">Configure ›</span>
          </SettingRow>
        </SheetGroup>
      </div>
    </>
  )

  const body =
    step.kind === 'setup' ? (
      <CatalogSetup
        candidate={step.candidate}
        busy={busy}
        onSave={(engines, key) =>
          void run(async () => {
            const { id, name } = step.candidate
            if (isSharedProviderId(id)) {
              // One key per provider (ADR-074 §6): a catalog definition with a
              // route per chosen engine, then the key ONCE — the vault stores it
              // and delivers it to each enabled engine.
              await window.api.saveSharedProvider(catalogDefinition(id, name, engines))
              await window.api.setSharedProviderApiKey(id, key)
            } else {
              // An id the vault cannot name (models.dev ids are not all
              // `[a-z0-9-]`): each engine keeps its own copy, as before.
              for (const engine of engines) await window.api.vendorAuthSetKey(engine, id, key)
            }
            await seedLargeCatalogAllowlists(engines, id)
            await onAdded(registryIdFor(engines[0], id))
          })
        }
        onOAuthDone={() =>
          void run(async () => {
            await seedLargeCatalogAllowlists(['opencode'], step.candidate.id)
            await onAdded(`opencode:${step.candidate.id}`)
          })
        }
      />
    ) : step.kind === 'custom' ? (
      <CustomEndpointStep
        busy={busy}
        onSave={(definition, key) =>
          void run(async () => {
            await window.api.saveSharedProvider(definition)
            if (key) await window.api.setSharedProviderApiKey(definition.id, key)
            await onAdded(definition.id)
          })
        }
      />
    ) : (
      listStep
    )

  return (
    <SheetFrame
      testid={SHEET}
      dataId={step.kind}
      title="Add provider"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
            {error ? (
              <span data-testid={`${SHEET}.error`} className="text-danger">
                {error}
              </span>
            ) : (
              'Pick one, then choose which engines get it.'
            )}
          </span>
          {step.kind !== 'list' && (
            <Button
              variant="link"
              testid={`${SHEET}.back`}
              onClick={() => {
                setError(null)
                setStep({ kind: 'list' })
              }}
            >
              Back
            </Button>
          )}
          <Button variant="primary" testid={`${SHEET}.cancel`} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <StepIndicator current={step.kind === 'list' ? 1 : 2} />
      {body}
    </SheetFrame>
  )
}

/**
 * The registry row id an API-key add produces: the definition's own id when it
 * became a shared catalog definition, else the native `<engine>:<id>` row.
 */
function registryIdFor(engine: ConfigurableHarnessId, providerId: string): string {
  return isSharedProviderId(providerId) ? providerId : `${engine}:${providerId}`
}

function isSharedProviderId(id: string): boolean {
  try {
    validateSharedProviderId(id)
    return true
  } catch {
    return false
  }
}

/** A catalog definition: no endpoint, no models — the engines' catalogs have them. */
function catalogDefinition(
  id: string,
  name: string,
  engines: readonly ConfigurableHarnessId[]
): SharedProviderDefinition {
  return {
    id,
    name,
    kind: 'catalog',
    models: [],
    managed: true,
    routes: {
      pi: { enabled: engines.includes('pi') },
      opencode: { enabled: engines.includes('opencode') }
    }
  }
}

/** Provider → Key & engines → Models (mockup D); the last step is the Manage sheet. */
const STEPS = ['Provider', 'Key & engines', 'Models'] as const

function StepIndicator({ current }: { current: 1 | 2 }): React.JSX.Element {
  return (
    <div
      data-testid={`${SHEET}.steps`}
      data-id={String(current)}
      className="flex flex-wrap items-center gap-2 mb-3 text-[12px] text-text-secondary"
    >
      {STEPS.map((label, i) => {
        const on = i + 1 === current
        return (
          <span key={label} className="inline-flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full border text-[11px] flex items-center justify-center ${
                on
                  ? 'bg-accent border-accent text-bg-secondary font-bold'
                  : 'border-border bg-bg-tertiary'
              }`}
            >
              {i + 1}
            </span>
            <span className={on ? 'text-text-primary' : undefined}>{label}</span>
            {i < STEPS.length - 1 && <span className="text-text-muted">—</span>}
          </span>
        )
      })}
    </div>
  )
}

/**
 * The anti-flood rule, per engine (ADR-074 §2): a freshly added provider whose
 * catalog in an engine is over {@link LARGE_CATALOG} models starts on "Only the
 * ones I pick" with nothing picked, so 300 OpenRouter models cannot land in the
 * picker at once. A smaller one is left on All models (no key at all).
 *
 * A provider that already has a key keeps it — re-adding a credential must not
 * wipe curation. A read that fails seeds nothing, and a write that fails is
 * logged and skipped: a missing key is All models, which is the safe way to be
 * wrong here.
 */
async function seedLargeCatalogAllowlists(
  engines: readonly ConfigurableHarnessId[],
  providerId: string
): Promise<void> {
  for (const engine of engines) {
    const adapter =
      engine === 'opencode' ? opencodeCurationAdapter(providerId) : piCurationAdapter(providerId)
    const [catalog, current] = await Promise.all([
      adapter.loadCatalog().catch(() => []),
      adapter.loadSelection().catch(() => null)
    ])
    if (current !== undefined || catalog.length <= LARGE_CATALOG) continue
    // The credential is already written: a failed seed must not fail the add.
    // The provider then starts on All models, which curation can still change.
    await adapter.save([]).catch((err: unknown) => {
      console.warn(`[ProviderAddSheet] seeding ${engine} allowlist for ${providerId} failed:`, err)
    })
  }
}

// ── Step 2a: a catalog pick ──────────────────────────────────────────

/**
 * "Enable for", then the credential. The engine chips are the ONLY ones the
 * candidate is offered by: a key written into an engine that does not know the
 * provider is a credential nothing will ever read.
 */
function CatalogSetup({
  candidate,
  busy,
  onSave,
  onOAuthDone
}: {
  candidate: Candidate
  busy: boolean
  onSave: (engines: ConfigurableHarnessId[], key: string) => void
  onOAuthDone: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<ConfigurableHarnessId[]>(candidate.engines)
  const [key, setKey] = useState('')

  return (
    <div data-testid={`${SHEET}.setup`} data-id={candidate.id}>
      <SheetGroup testid={`${SHEET}.group`} id="setup" label={`Add ${candidate.name}`}>
        <SettingRow
          testid={`${SHEET}.enableFor`}
          layout="stacked"
          label="Use it in"
          description="The key is delivered to each selected engine’s own auth file."
        >
          <ChipSet
            testid={`${SHEET}.engines`}
            value={selected}
            options={candidate.engines.map((engine) => ({ value: engine, label: engine }))}
            onToggle={(value) =>
              setSelected((current) =>
                current.includes(value as ConfigurableHarnessId)
                  ? current.filter((engine) => engine !== value)
                  : [...current, value as ConfigurableHarnessId]
              )
            }
          />
        </SettingRow>

        <SettingRow
          testid={`${SHEET}.key`}
          label="API key"
          description="Entered once. ClaudeUI stores it and delivers it to each engine you pick."
        >
          <TextField
            type="password"
            testid={`${SHEET}.keyInput`}
            value={key}
            onChange={setKey}
            placeholder="Paste the key"
            className="w-[150px]"
          />
          <Button
            variant="link"
            testid={`${SHEET}.save`}
            disabled={busy || key.trim().length === 0 || selected.length === 0}
            onClick={() => onSave(selected, key.trim())}
          >
            Save
          </Button>
        </SettingRow>

        {candidate.oauthLabel && (
          <div className="px-3.5 py-2.5">
            <div className="text-[13px] leading-[18px] text-text-primary">Or sign in</div>
            <div className="text-[12px] leading-4 text-text-secondary mb-2">
              opencode holds the resulting credential in its own auth store.
            </div>
            <VendorOAuthFlow
              engineId="opencode"
              vendorId={candidate.id}
              label={candidate.oauthLabel}
              disabled={busy || !selected.includes('opencode')}
              onDone={onOAuthDone}
            />
          </div>
        )}
      </SheetGroup>
    </div>
  )
}

// ── Step 2b: a custom endpoint ─────────────────────────────────

/**
 * The shared vault's definition form (`ProviderForm`), with this sheet's own
 * Save. The Manage sheet mounts the same form to EDIT one — which is why the
 * fields, the normalisation and the required-field rule live there rather than
 * here.
 */
function CustomEndpointStep({
  busy,
  onSave
}: {
  busy: boolean
  onSave: (definition: SharedProviderDefinition, key: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<SharedProviderDefinition>(blankProviderDraft)
  const [key, setKey] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)

  return (
    <div data-testid={`${SHEET}.customForm`}>
      <ProviderForm
        draft={draft}
        onDraft={setDraft}
        apiKey={key}
        onApiKey={setKey}
        error={invalid}
      />
      <div className="mt-3 flex justify-end">
        <Button
          variant="tinted"
          testid={`${SHEET}.customSave`}
          disabled={busy}
          onClick={() => {
            const result = normalizeProviderDraft(draft)
            if ('error' in result) {
              setInvalid(result.error)
              return
            }
            setInvalid(null)
            onSave(result.definition, key)
          }}
        >
          Save endpoint
        </Button>
      </div>
    </div>
  )
}
