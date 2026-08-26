/**
 * Scoped model-override env state for cli.js spawns.
 *
 * Mirrors the proxy.ts / endpoint-env.ts pattern: keep the model env vars out
 * of the Electron main process env so they don't leak into PTYs, simple-git,
 * MCP, or plugin hosts. Overlaid only onto the cli.js spawn env via buildEnv().
 *
 * Mapping:
 *   ANTHROPIC_MODEL              — initial selection (alias like 'sonnet' or
 *                                   a full model name)
 *   ANTHROPIC_DEFAULT_SONNET_MODEL — what the `sonnet` alias resolves to
 *   ANTHROPIC_DEFAULT_OPUS_MODEL   — what the `opus` alias resolves to
 *   ANTHROPIC_DEFAULT_HAIKU_MODEL  — what the `haiku` alias resolves to
 *                                   (replaces the deprecated
 *                                    ANTHROPIC_SMALL_FAST_MODEL)
 *
 * Empty string fields are skipped — buildEnv() only sets the env var when a
 * non-empty value is present, so a partial override leaves cli.js's defaults
 * intact for the unset families.
 */

export interface ModelEnv {
  ANTHROPIC_MODEL: string
  ANTHROPIC_DEFAULT_SONNET_MODEL: string
  ANTHROPIC_DEFAULT_OPUS_MODEL: string
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string
}

let current: ModelEnv | null = null

export function setModelEnv(env: ModelEnv | null): void {
  current = env
}

export function getModelEnv(): ModelEnv | null {
  return current
}
