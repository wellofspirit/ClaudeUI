/**
 * The environment a detection probe starts from: a short allowlist of the
 * parent's, never the whole of it. The parent environment may hold API keys
 * and tokens, and a `--version` probe of an arbitrary system binary needs
 * none of them.
 */
import { envGet } from './path-entries'

/** The variables a probe inherits: enough to find DLLs, temp and home, and nothing else. */
export const PROBE_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG'
] as const

/** The allowlisted variables of `parent` (looked up case-insensitively on Windows). */
export function minimalEnv(
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PROBE_ENV_ALLOWLIST) {
    const value = envGet(parent, name, platform)
    if (value !== undefined) env[name] = value
  }
  return env
}
