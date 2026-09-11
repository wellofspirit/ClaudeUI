import type { CodexSettings } from '../../shared/codex-types'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'

const isSettableValue = (value: unknown): boolean =>
  typeof value === 'string' && !!value.trim() && value.length <= 256

/**
 * Validate a settings request from the app. Strict: an unknown key (including
 * the retired `approvalPolicy`/`sandbox`/`approvalsReviewer` policy keys — the
 * session's shared PermissionMode owns those now) is a rejection, so a stale
 * client cannot quietly reconfigure native policy behind the gate.
 */
export function parseCodexSettings(value: unknown): CodexSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Codex settings')
  const settings = value as Record<string, unknown>
  if (settings.reset === true && Object.keys(settings).length === 1) return { reset: true }
  for (const [key, entry] of Object.entries(settings)) {
    if (!['model', 'effort'].includes(key) || !isSettableValue(entry))
      throw new Error('Unsupported Codex setting or value')
  }
  return { ...settings } as CodexSettings
}

/**
 * Read a PERSISTED overrides row. Lenient where {@link parseCodexSettings} is
 * strict: rows written before slice 3 carry `approvalPolicy`/`sandbox`/
 * `approvalsReviewer`, and a saved row is not a client request — throwing would
 * make every such session unopenable. Unknown and malformed keys are dropped,
 * so only model/effort survive to be replayed.
 */
export function savedCodexOverrides(value: unknown): Omit<CodexSettings, 'reset'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  return {
    ...(isSettableValue(row.model) ? { model: row.model as string } : {}),
    ...(isSettableValue(row.effort) ? { effort: row.effort as string } : {})
  }
}

export function codexSandboxPolicy(
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
): SandboxPolicy {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}
