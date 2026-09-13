import type { CodexSettings } from '../../shared/codex-types'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'

const isSettableValue = (value: unknown): boolean =>
  typeof value === 'string' && !!value.trim() && value.length <= 256

/**
 * `accountId` is the ONE key whose `null` carries meaning (ADR-068 §2): a string
 * pins a stored vault account for this session, an explicit null clears the pin
 * so the session follows the ACTIVE account, and an absent key leaves whatever
 * is stored alone. Model and effort have no such third state — a null there is
 * just a malformed write.
 */
const isSettableAccountId = (value: unknown): boolean => value === null || isSettableValue(value)

/**
 * Validate a native settings write — the `session:set-model` / `session:set-effort`
 * commands on their way to `thread/settings/update`, the `session:set-account`
 * pin, and the overrides row they persist. Strict: an unknown key (including the
 * retired `approvalPolicy`/`sandbox`/`approvalsReviewer` policy keys — the
 * session's shared PermissionMode owns those now) is a rejection, so nothing can
 * quietly reconfigure native policy behind the gate.
 */
export function parseCodexSettings(value: unknown): CodexSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Codex settings')
  const settings = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(settings)) {
    const ok = key === 'accountId' ? isSettableAccountId(entry) : isSettableValue(entry)
    if (!['model', 'effort', 'accountId'].includes(key) || !ok)
      throw new Error('Unsupported Codex setting or value')
  }
  return { ...settings } as CodexSettings
}

/**
 * Read a PERSISTED overrides row. Lenient where {@link parseCodexSettings} is
 * strict: rows written before slice 3 carry `approvalPolicy`/`sandbox`/
 * `approvalsReviewer`, and a saved row is not a client request — throwing would
 * make every such session unopenable. Unknown and malformed keys are dropped,
 * so only model/effort/accountId survive to be replayed.
 *
 * A STRING is the only pin a read restores: `null` and absent both mean "follow
 * the active account", so collapsing them here keeps `start()` from having to
 * tell two spellings of the same thing apart.
 */
export function savedCodexOverrides(value: unknown): CodexSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  return {
    ...(isSettableValue(row.model) ? { model: row.model as string } : {}),
    ...(isSettableValue(row.effort) ? { effort: row.effort as string } : {}),
    ...(isSettableValue(row.accountId) ? { accountId: row.accountId as string } : {})
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
