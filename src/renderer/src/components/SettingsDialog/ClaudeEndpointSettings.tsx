import { useState } from 'react'
import type {
  AnthropicEndpointSettings,
  ModelOverrideSettings,
  VendorConfig
} from '../../../../shared/types'
import { ChoiceCards, SettingRow, SettingsToggle, TextField, Button } from './settings-controls'

/**
 * Claude › Endpoint and Claude › Model mapping — the two group bodies over
 * `vendors/anthropic.json` (ADR-074 §9).
 *
 * They lived on Models & providers as one form, but nothing in that file ever
 * reaches opencode or pi: `claude-spawn-prep` holds the endpoint and the model
 * env for cli.js spawns only. So they sit on the engine they configure.
 *
 * The endpoint is ONE question first — Anthropic or a custom gateway — and the
 * gateway's fields exist only once it is the answer, rather than as greyed-out
 * rows under an off switch. Choosing Anthropic flips `enabled` and nothing
 * else, so the stored URL and token come back when the gateway is picked again.
 *
 * The model mapping is its two real jobs with a switch each: PIN one model
 * (`ANTHROPIC_MODEL`) and RENAME the aliases (`ANTHROPIC_DEFAULT_*_MODEL`). Every
 * switch writes BOTH new flags plus the legacy `enabled`, so an older build
 * reading the same file still sees "on" whenever either job is (the fallback
 * rule is `effectiveModelOverride`'s, shared/model-override.ts).
 *
 * Every write goes through `updateVendorConfig` as a whole-object patch, the
 * shape the file has always had.
 */

/** Testid namespaces (ADR-027). */
const E = 'ClaudeEndpointSection'
const M = 'ClaudeModelMappingSection'

const DEFAULT_ENDPOINT: AnthropicEndpointSettings = { enabled: false, baseUrl: '', authToken: '' }
const DEFAULT_MODEL_OVERRIDE: ModelOverrideSettings = {
  enabled: false,
  model: '',
  sonnetModel: '',
  opusModel: '',
  haikuModel: ''
}

type EndpointChoice = 'anthropic' | 'gateway'

const ENDPOINT_OPTIONS = [
  {
    value: 'anthropic' as const,
    label: 'Anthropic',
    description: 'api.anthropic.com, with your Claude sign-in.'
  },
  {
    value: 'gateway' as const,
    label: 'A custom gateway',
    description: 'An Anthropic-compatible proxy or gateway.'
  }
]

/** The three aliases, the field each is stored in, and the env var it sets. */
const ALIASES: ReadonlyArray<{
  alias: string
  field: 'sonnetModel' | 'opusModel' | 'haikuModel'
  envVar: string
}> = [
  { alias: 'sonnet', field: 'sonnetModel', envVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { alias: 'opus', field: 'opusModel', envVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  { alias: 'haiku', field: 'haikuModel', envVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' }
]

interface VendorProps {
  vendorConfig: VendorConfig
  updateVendorConfig: (p: Partial<VendorConfig>) => void
}

export function ClaudeEndpointSection({
  vendorConfig,
  updateVendorConfig
}: VendorProps): React.JSX.Element {
  const endpoint: AnthropicEndpointSettings = vendorConfig.endpoint ?? DEFAULT_ENDPOINT
  /** Reveal is per-view and deliberately not persisted anywhere. */
  const [revealToken, setRevealToken] = useState(false)
  const choice: EndpointChoice = endpoint.enabled ? 'gateway' : 'anthropic'
  const write = (p: Partial<AnthropicEndpointSettings>): void =>
    updateVendorConfig({ endpoint: { ...endpoint, ...p } })

  return (
    <div data-testid={E} className="divide-y divide-border/55">
      <SettingRow testid={`${E}.targetRow`} layout="stacked" description="Claude sends requests to">
        <ChoiceCards
          testid={`${E}.target`}
          ariaLabel="Claude sends requests to"
          value={choice}
          options={ENDPOINT_OPTIONS}
          onChange={(v) => write({ enabled: v === 'gateway' })}
        />
      </SettingRow>

      {choice === 'gateway' && (
        <>
          <SettingRow testid={`${E}.baseUrlRow`} label="Base URL">
            <TextField
              testid={`${E}.baseUrl`}
              className="w-[300px]"
              value={endpoint.baseUrl}
              placeholder="https://gateway.example/anthropic"
              onChange={(v) => write({ baseUrl: v })}
            />
          </SettingRow>

          <SettingRow testid={`${E}.authTokenRow`} label="Auth token">
            <TextField
              testid={`${E}.authToken`}
              type={revealToken ? 'text' : 'password'}
              className="w-[240px]"
              value={endpoint.authToken}
              placeholder="sk-ant-…"
              onChange={(v) => write({ authToken: v })}
            />
            <Button
              testid={`${E}.revealToken`}
              variant="link"
              onClick={() => setRevealToken((v) => !v)}
            >
              {revealToken ? 'Hide' : 'Reveal'}
            </Button>
          </SettingRow>

          <SettingRow
            testid={`${E}.tokenHint`}
            description={
              <>
                Sent as <span className="font-mono">Authorization: Bearer</span>. Leave empty to
                send your Claude sign-in instead.
              </>
            }
          />
        </>
      )}
    </div>
  )
}

export function ClaudeModelMappingSection({
  vendorConfig,
  updateVendorConfig
}: VendorProps): React.JSX.Element {
  const mo: ModelOverrideSettings = vendorConfig.modelOverride ?? DEFAULT_MODEL_OVERRIDE
  // The same fallback `effectiveModelOverride` applies at spawn: a file from
  // before the split has only `enabled`, which both switches inherit.
  const pinOn = mo.pinEnabled ?? mo.enabled
  const renameOn = mo.renameEnabled ?? mo.enabled

  /** Both flags are always materialised, so neither keeps falling back. */
  const setSwitches = (pin: boolean, rename: boolean): void =>
    updateVendorConfig({
      modelOverride: { ...mo, pinEnabled: pin, renameEnabled: rename, enabled: pin || rename }
    })
  const setField = (field: keyof ModelOverrideSettings, v: string): void =>
    updateVendorConfig({ modelOverride: { ...mo, [field]: v } })

  return (
    <div data-testid={M} className="divide-y divide-border/55">
      <SettingsToggle
        testid={`${M}.pin`}
        label="Pin one model for every session"
        description="Overrides the model picker and the default model."
        keyText="ANTHROPIC_MODEL"
        checked={pinOn}
        onChange={(v) => setSwitches(v, renameOn)}
      />
      {pinOn && (
        <SettingRow testid={`${M}.pinModelRow`} indent label="Model">
          <TextField
            testid={`${M}.pinModel`}
            value={mo.model}
            placeholder="a model id your endpoint serves"
            onChange={(v) => setField('model', v)}
          />
        </SettingRow>
      )}

      <SettingsToggle
        testid={`${M}.rename`}
        label="Rename the model aliases"
        description="For gateways that call Claude's models something else. An empty field keeps Claude's own name."
        checked={renameOn}
        onChange={(v) => setSwitches(pinOn, v)}
      />
      {renameOn &&
        ALIASES.map(({ alias, field, envVar }) => (
          <SettingRow
            key={alias}
            testid={`${M}.aliasRow`}
            dataId={alias}
            indent
            keyText={envVar}
            leading={
              <span className="shrink-0 w-[64px]">
                <span className="font-mono text-[11px] leading-4 px-1.5 rounded-[5px] bg-bg-primary border border-border text-text-secondary">
                  {alias}
                </span>
              </span>
            }
          >
            <TextField
              testid={`${M}.aliasModel`}
              dataId={alias}
              value={mo[field]}
              placeholder="unchanged"
              onChange={(v) => setField(field, v)}
            />
          </SettingRow>
        ))}
    </div>
  )
}
