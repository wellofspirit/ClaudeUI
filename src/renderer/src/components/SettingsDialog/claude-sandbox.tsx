/**
 * The Claude page's Sandbox group (ADR-009). Every row shows the replicated
 * `claudeSandbox` store value, the `sandbox` block of Claude Code's own user settings file,
 * and saves a patch holding only its own field through `setClaudeSandbox`. A row never flips
 * ahead of the host's echo; a refused write is shown in the row that asked for it. The
 * remembered domain list is the one thing kept in ClaudeUI's own engine config (the file holds
 * no list while "restrict network" is off).
 */
import { useCallback, useEffect, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { ipcErrorMessage } from '../../utils/ipc-error'
import type {
  ClaudeSandboxScope,
  EngineConfig,
  SandboxSettings,
  SandboxSettingsPatch
} from '../../../../shared/types'
import { SandboxListSetting, SettingRow, SettingsToggle } from './settings-controls'

const SCOPE_FILE: Record<ClaudeSandboxScope, string> = {
  project: '.claude/settings.json',
  local: '.claude/settings.local.json',
  managed: 'the managed settings'
}

/** The store value and a save that keeps its own error (one instance per row). */
function useClaudeSandbox(): {
  settings: SandboxSettings
  supported: boolean
  error: string | undefined
  save: (patch: SandboxSettingsPatch) => void
} {
  const settings = useSessionStore((s) => s.claudeSandbox.settings)
  const supported = useSessionStore((s) => s.claudeSandbox.supported)
  const [error, setError] = useState<string | undefined>(undefined)
  const save = useCallback((patch: SandboxSettingsPatch): void => {
    window.api
      .setClaudeSandbox(patch)
      .then(() => setError(undefined))
      // The handler's own sentence, without the wrapper the desktop transport adds.
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }, [])
  return { settings, supported, error, save }
}

interface ToggleProps {
  testid: string
  label: string
  description: string
  read: (s: SandboxSettings) => boolean
  patch: (v: boolean) => SandboxSettingsPatch
  /** The row is live only while this holds (default: the sandbox is on). */
  live?: (s: SandboxSettings) => boolean
}

export function SandboxToggleRow({
  testid,
  label,
  description,
  read,
  patch,
  live = (s) => s.enabled
}: ToggleProps): React.JSX.Element {
  const { settings, error, save } = useClaudeSandbox()
  const off = !live(settings)
  return (
    <SettingsToggle
      testid={testid}
      label={label}
      description={description}
      checked={read(settings)}
      onChange={(v) => save(patch(v))}
      error={error}
      indent
      dimmed={off}
      disabled={off}
    />
  )
}

interface ListProps {
  testid: string
  label: string
  description: string
  placeholder: string
  read: (s: SandboxSettings) => string[]
  patch: (items: string[]) => SandboxSettingsPatch
  live?: (s: SandboxSettings) => boolean
}

export function SandboxListRow({
  testid,
  label,
  description,
  placeholder,
  read,
  patch,
  live = (s) => s.enabled
}: ListProps): React.JSX.Element {
  const { settings, error, save } = useClaudeSandbox()
  const off = !live(settings)
  return (
    <SandboxListSetting
      testid={testid}
      label={label}
      labelColor="text-text-primary"
      description={description}
      items={read(settings)}
      placeholder={placeholder}
      onUpdate={(items) => save(patch(items))}
      error={error}
      indent
      dimmed={off}
      disabled={off}
    />
  )
}

/** The master switch, its unsupported-host text and the project note beneath it. */
export function SandboxMainRow(): React.JSX.Element {
  const { settings, supported, error, save } = useClaudeSandbox()
  const on = settings.enabled
  const unsupportedOff = !supported && !on
  return (
    <>
      <SettingsToggle
        testid="ClaudeSandbox.enabled"
        label="Command sandbox"
        description={
          <>
            Runs shell commands in an isolated environment — macOS sandbox-exec or Linux bubblewrap,
            deny-by-default. Claude Code's own setting, kept in its settings file and shared with
            the claude CLI.
            {unsupportedOff && (
              <span data-testid="ClaudeSandbox.enabled.unsupported" className="block mt-1">
                The sandbox cannot run on this host.
              </span>
            )}
            {!supported && on && (
              <span data-testid="ClaudeSandbox.enabled.warning" className="block mt-1 text-warning">
                The sandbox cannot run on this host: Claude sessions will not start here until it is
                turned off.
              </span>
            )}
          </>
        }
        checked={on}
        onChange={(v) => save({ enabled: v })}
        error={error}
        disabled={unsupportedOff}
      />
      <SandboxProjectNote />
    </>
  )
}

/** Read-only: the active session's directory turns the sandbox on in its own settings. */
function SandboxProjectNote(): React.JSX.Element | null {
  const cwd = useActiveSession((s) => s.cwd)
  const [scopes, setScopes] = useState<ClaudeSandboxScope[]>([])
  useEffect(() => {
    if (!cwd) {
      setScopes([])
      return
    }
    let live = true
    window.api
      .claudeSandboxScopes(cwd)
      .then((r) => live && setScopes(r))
      .catch(() => live && setScopes([]))
    return () => {
      live = false
    }
  }, [cwd])
  if (scopes.length === 0) return null
  return (
    <SettingRow
      testid="ClaudeSandbox.projectNote"
      indent
      description={`This project's own settings turn the sandbox on (${scopes.map((s) => SCOPE_FILE[s]).join(', ')}). Claude Code applies it there whatever this switch says.`}
    />
  )
}

/**
 * "Restrict network access": the shared file holds a domain list only while it is on. Turning
 * it off parks the list in the engine config (`sandboxRememberedDomains`); turning it on sends
 * it back.
 */
export function SandboxRestrictNetworkRow({
  engineConfig,
  updateEngineConfig
}: {
  engineConfig: EngineConfig
  updateEngineConfig: (p: Partial<EngineConfig>) => void
}): React.JSX.Element {
  const { settings, error, save } = useClaudeSandbox()
  const claudeConfig = engineConfig.claudeConfig ?? {}
  const off = !settings.enabled
  const toggle = (v: boolean): void => {
    if (v) {
      save({
        network: {
          restrictNetwork: true,
          allowedDomains: claudeConfig.sandboxRememberedDomains ?? []
        }
      })
      return
    }
    const next = { ...claudeConfig }
    if (settings.network.allowedDomains.length > 0) {
      next.sandboxRememberedDomains = settings.network.allowedDomains
    } else delete next.sandboxRememberedDomains
    updateEngineConfig({ claudeConfig: next })
    save({ network: { restrictNetwork: false } })
  }
  return (
    <SettingsToggle
      testid="ClaudeSandbox.restrictNetwork"
      label="Restrict network access"
      description="Blocks every outbound connection except the domains listed below; off leaves the sandbox's network open."
      checked={settings.network.restrictNetwork}
      onChange={toggle}
      error={error}
      indent
      dimmed={off}
      disabled={off}
    />
  )
}

/** "Allowed domains": the file's list while restricted, the remembered one (inert) otherwise. */
export function SandboxAllowedDomainsRow({
  engineConfig
}: {
  engineConfig: EngineConfig
}): React.JSX.Element {
  const { settings, error, save } = useClaudeSandbox()
  const restricted = settings.network.restrictNetwork
  const off = !(settings.enabled && restricted)
  return (
    <SandboxListSetting
      testid="ClaudeSandbox.allowedDomains"
      label="Allowed domains"
      labelColor="text-text-primary"
      description="Domains sandboxed commands may reach, wildcards like *.npmjs.org included; empty blocks all outbound traffic."
      items={
        restricted
          ? settings.network.allowedDomains
          : (engineConfig.claudeConfig?.sandboxRememberedDomains ?? [])
      }
      placeholder="e.g. registry.npmjs.org"
      onUpdate={(items) => save({ network: { allowedDomains: items } })}
      error={error}
      indent
      dimmed={off}
      disabled={off}
    />
  )
}
