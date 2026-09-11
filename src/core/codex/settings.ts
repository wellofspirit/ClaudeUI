import type { CodexSettings } from '../../shared/codex-types'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'

export function parseCodexSettings(value: unknown): CodexSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Codex settings')
  const settings = value as Record<string, unknown>
  if (settings.reset === true && Object.keys(settings).length === 1) return { reset: true }
  for (const [key, value] of Object.entries(settings)) {
    const allowed =
      key === 'approvalPolicy'
        ? ['untrusted', 'on-request', 'never']
        : key === 'sandbox'
          ? ['read-only', 'workspace-write', 'danger-full-access']
          : key === 'approvalsReviewer'
            ? ['user']
            : null
    if (
      allowed
        ? !allowed.includes(value as string)
        : !['model', 'effort'].includes(key) ||
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 256
    )
      throw new Error('Unsupported Codex setting or value')
  }
  return { ...settings } as CodexSettings
}

export function codexSandboxPolicy(mode: NonNullable<CodexSettings['sandbox']>): SandboxPolicy {
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
