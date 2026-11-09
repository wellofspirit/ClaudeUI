/**
 * The shared Claude skill catalog as the opencode side reads it (docs/architecture/skill-catalog.md).
 * The plugin gets the catalog over the host's `/skills` route (`mcp-http-host.ts`); the session and
 * the Skills dialog read it directly through here.
 */
import { resolveClaudeSkillCatalog } from '../services/claude-skill-catalog'
import type { ClaudeSkillCatalog } from '../services/claude-skill-catalog'
import { logger } from '../services/logger'

/** The catalog of `cwd`; a resolver failure is no catalog (the contract says it never throws). */
export function safeSkillCatalog(cwd: string): ClaudeSkillCatalog {
  try {
    return resolveClaudeSkillCatalog(cwd)
  } catch (err) {
    logger.warn(
      'opencode',
      `Claude skill catalog failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`
    )
    return { entries: [], skipped: [] }
  }
}
