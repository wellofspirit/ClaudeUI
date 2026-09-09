/**
 * ProviderForm — the shared vault's custom-endpoint definition, on the row
 * vocabulary (ADR-065 phase 6c).
 *
 * It is `SharedProviders`' `ProviderForm` re-dressed and moved here: same
 * fields, same normalisation, same required-field rule, because the definition
 * it produces is read by the two adapters that project it into pi's
 * `models.json` and opencode's config. What changed is where it lives — the
 * vault's own pane is gone, and BOTH sheets need this form:
 *
 *  · the Add sheet's CUSTOM ENDPOINT step declares a new one;
 *  · the Manage sheet's "Edit endpoint" changes one that exists.
 *
 * The id is LOCKED when editing. `providers.<id>` is the key both adapters
 * project under, so re-typing it would not rename a provider — it would declare
 * a second one and orphan the first (the vault has no rename verb).
 *
 * The API key is write-only in both hosts. It never travels inside the
 * definition (`shared-provider:save` is config, `shared-provider:set-key` is
 * the credential) and is never read back, which is why the field is blank even
 * when a key exists.
 */

import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderProtocol
} from '../../../../shared/shared-provider'
import { Button, ChipSet, SelectField, SettingRow, TextField } from './settings-controls'
import { SheetGroup } from './SheetFrame'

/** Testid namespace (ADR-027 tier 1/2). */
const FORM = 'ProviderForm'

/** Wire protocols a custom shared provider can speak. First entry = the default. */
export const PROTOCOL_OPTIONS: { value: SharedProviderProtocol; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI completions' },
  { value: 'openai-responses', label: 'OpenAI responses' },
  { value: 'anthropic-messages', label: 'Anthropic messages' }
]

const HARNESSES: readonly ConfigurableHarnessId[] = ['pi', 'opencode']

/** The message `SharedProviders` used, unchanged — it names all three fields. */
export const REQUIRED_FIELDS_MESSAGE = 'Provider id, name, and model id are required'

/** A blank draft: one empty model row, both routes on. */
export function blankProviderDraft(): SharedProviderDefinition {
  return {
    id: '',
    name: '',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: '',
    models: [{ id: '', name: '' }],
    routes: { pi: { enabled: true }, opencode: { enabled: true } },
    managed: true
  }
}

/**
 * Trim the draft into the definition to save, or return the required-field
 * message. One function, so the Add and Edit paths cannot disagree about what a
 * valid definition is.
 */
export function normalizeProviderDraft(
  draft: SharedProviderDefinition
): { definition: SharedProviderDefinition } | { error: string } {
  if (!draft.id.trim() || !draft.name.trim() || draft.models.some((model) => !model.id.trim())) {
    return { error: REQUIRED_FIELDS_MESSAGE }
  }
  return {
    definition: {
      ...draft,
      id: draft.id.trim(),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl?.trim(),
      models: draft.models.map((model) => {
        const name = model.name?.trim()
        return { ...model, id: model.id.trim(), name: name || undefined }
      })
    }
  }
}

export function ProviderForm({
  draft,
  onDraft,
  apiKey,
  onApiKey,
  error,
  idLocked = false
}: {
  draft: SharedProviderDefinition
  onDraft: (next: SharedProviderDefinition) => void
  apiKey: string
  onApiKey: (next: string) => void
  /** The last save's refusal — validation here, or the writer's own words. */
  error?: string | null
  /** Editing an existing definition: the id is its key in three stores. */
  idLocked?: boolean
}): React.JSX.Element {
  const set = (patch: Partial<SharedProviderDefinition>): void => onDraft({ ...draft, ...patch })
  const setModel = (index: number, patch: Partial<SharedProviderModel>): void =>
    set({ models: draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model)) })

  return (
    <div data-testid={FORM} data-id={draft.id || 'new'}>
      <SheetGroup testid={`${FORM}.group`} id="endpoint" label="Endpoint">
        <SettingRow
          testid={`${FORM}.field`}
          dataId="id"
          label="Provider id"
          description={
            idLocked
              ? 'The key each engine stores this provider under. Fixed after creation.'
              : 'The key each engine will store this provider under.'
          }
        >
          <TextField
            testid={`${FORM}.id`}
            value={draft.id}
            disabled={idLocked}
            onChange={(value) => set({ id: value })}
            placeholder="internal-gateway"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow testid={`${FORM}.field`} dataId="name" label="Display name">
          <TextField
            testid={`${FORM}.name`}
            mono={false}
            value={draft.name}
            onChange={(value) => set({ name: value })}
            placeholder="Internal gateway"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="protocol"
          label="Protocol"
          description="The wire format this endpoint speaks."
        >
          <SelectField
            testid={`${FORM}.protocol`}
            value={draft.protocol ?? PROTOCOL_OPTIONS[0].value}
            options={PROTOCOL_OPTIONS}
            onChange={(value) => set({ protocol: value as SharedProviderProtocol })}
          />
        </SettingRow>
        <SettingRow testid={`${FORM}.field`} dataId="baseUrl" label="Base URL">
          <TextField
            testid={`${FORM}.baseUrl`}
            value={draft.baseUrl ?? ''}
            onChange={(value) => set({ baseUrl: value })}
            placeholder="https://llm.example/v1"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="routes"
          label="Enable for"
          description="One definition, projected into every enabled engine."
        >
          <ChipSet
            testid={`${FORM}.engines`}
            value={HARNESSES.filter((harness) => draft.routes[harness].enabled)}
            options={HARNESSES.map((harness) => ({ value: harness, label: harness }))}
            onToggle={(value) => {
              const harness = value as ConfigurableHarnessId
              set({
                routes: {
                  ...draft.routes,
                  [harness]: { ...draft.routes[harness], enabled: !draft.routes[harness].enabled }
                }
              })
            }}
          />
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="models"
          layout="stacked"
          label="Models"
          description="What this endpoint serves. Every delivered model stays available unless an engine’s own list restricts it."
          error={error ?? undefined}
          errorTestid={`${FORM}.error`}
        >
          <span className="block space-y-1.5">
            {draft.models.map((model, index) => (
              <span key={index} className="flex items-center gap-1.5">
                <TextField
                  testid={`${FORM}.modelId`}
                  dataId={String(index)}
                  value={model.id}
                  onChange={(value) => setModel(index, { id: value })}
                  placeholder="Model ID"
                  className="flex-1 min-w-0"
                />
                <TextField
                  testid={`${FORM}.modelName`}
                  dataId={String(index)}
                  mono={false}
                  value={model.name ?? ''}
                  onChange={(value) => setModel(index, { name: value })}
                  placeholder="Display name (optional)"
                  className="flex-1 min-w-0"
                />
                <Button
                  variant="link"
                  testid={`${FORM}.removeModel`}
                  dataId={String(index)}
                  onClick={() => set({ models: draft.models.filter((_, i) => i !== index) })}
                >
                  Remove
                </Button>
              </span>
            ))}
            <Button
              variant="link"
              testid={`${FORM}.addModel`}
              onClick={() => set({ models: [...draft.models, { id: '', name: '' }] })}
            >
              + Add model
            </Button>
          </span>
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="key"
          label="API key"
          description="Optional. Held once by ClaudeUI and vended to each enabled engine; never read back, so this field starts empty even when a key is set."
        >
          <TextField
            type="password"
            testid={`${FORM}.key`}
            value={apiKey}
            onChange={onApiKey}
            placeholder={idLocked ? 'Set or replace the key' : 'Set an API key'}
            className="w-[150px]"
          />
        </SettingRow>
      </SheetGroup>
    </div>
  )
}
