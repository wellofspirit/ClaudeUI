import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { logger } from '../services/logger'
import type { SkillInfo } from '../../shared/types'
import type { Agent_Info, Skill_Info } from './protocol-v2/openapi'
import { evaluateV2Call } from './wildcard'

// Per-cwd cache of discovered skills. Keyed by normalized absolute cwd.
const skillCache = new Map<string, SkillInfo[]>()

/**
 * Does EVERY agent of this directory deny `skill`? 2.x hides a skill a rule denies from
 * the `skill` tool (`core/src/skill.ts` `available`: `Permission.evaluate("skill", id)`, last
 * match wins), while `GET /api/skill` lists every REGISTERED skill, so the two disagree.
 *
 * The case that matters: upstream's browser plugin registers a `Browser` skill (id
 * `browser`, `packages/plugin-browser/src/skill.ts`) and appends
 * `{action:"skill", resource:"browser", effect:"deny"}` to EVERY agent
 * (`packages/plugin-browser/src/connection.ts`, "Appended after config, so every agent
 * hides the browser until an attachment allows it"); only an attached browser adds the
 * allow, and ClaudeUI never attaches one. At v2.2.5 `GET /api/agent` carries that rule.
 *
 * Unknown is not denied: an empty or failed `agent.list` must not empty the dialog, so
 * such a skill stays listed (the model still cannot load it).
 */
function noAgentOffers(skill: Skill_Info, agents: readonly Agent_Info[]): boolean {
  return (
    agents.length > 0 &&
    agents.every((agent) => evaluateV2Call(agent.permissions ?? [], 'skill', [skill.id]) === 'deny')
  )
}

/**
 * Discover opencode skills for a given working directory by spinning up a
 * transient server, calling GET /api/skill (for THIS directory — the client
 * sends it as `x-opencode-directory`), mapping the result to SkillInfo[], then
 * releasing the server.
 *
 * Mirrors model-discovery.ts: acquire → fetch → release, cwd-keyed cache,
 * degrade to [] on any failure (opencode is optional — Claude must not break).
 *
 * opencode 2.x `Skill.Info { id, name, description?, path, content }` → SkillInfo with
 * `source: 'project'` (closest valid union value — opencode unifies project/user
 * sources; the dialog renders them identically, so the distinction doesn't matter).
 */
export async function discoverOpencodeSkills(cwd: string): Promise<SkillInfo[]> {
  const hit = skillCache.get(cwd)
  if (hit) return hit

  try {
    // Lists only — no turn, so no wait for the hosted MCP tools.
    const conn = await opencodeServerManager.acquire(cwd, { waitForHostedTools: false })
    const client = new OpencodeClient(conn)
    try {
      const skills = await client.skills()
      // A skill every agent denies is not offered to any model: do not offer it here.
      const agents = await client.agents().catch(() => [] as readonly Agent_Info[])
      const result: SkillInfo[] = skills
        .filter((s) => !noAgentOffers(s, agents))
        .map((s) => ({
          name: s.name,
          displayName: s.name,
          description: s.description ?? '',
          // opencode doesn't expose a source taxonomy — use 'project' as a neutral
          // "available in this workspace" value (all valid SkillSource values render
          // identically in the Skills dialog).
          source: 'project' as const,
          path: s.path,
          content: s.content
        }))
      skillCache.set(cwd, result)
      return result
    } finally {
      opencodeServerManager.releaseIfCurrent(cwd, conn)
    }
  } catch (err) {
    logger.warn(
      'opencode',
      `Skill discovery failed for ${cwd} (opencode optional): ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}

/** Invalidate the skill discovery cache for a specific cwd (e.g. on auth change). */
export function invalidateOpencodeSkillCache(cwd?: string): void {
  if (cwd) {
    skillCache.delete(cwd)
  } else {
    skillCache.clear()
  }
}
