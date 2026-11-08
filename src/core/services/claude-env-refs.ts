/**
 * Claude Code's `${VAR}` / `${VAR:-default}` expansion of an `.mcp.json` string.
 * The catalog leaves these unexpanded; each engine bridge expands for itself.
 */

const CLAUDE_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Expand against `env`. A variable that is unset (or empty) with no default
 * stays as written, and its NAME is collected in `missing` — the value itself
 * is never logged.
 */
export function expandClaudeEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): string {
  return value.replace(CLAUDE_ENV_REF, (whole, name: string, fallback: string | undefined) => {
    const set = env[name]
    if (set !== undefined && set !== '') return set
    if (fallback !== undefined) return fallback
    missing.add(name)
    return whole
  })
}
