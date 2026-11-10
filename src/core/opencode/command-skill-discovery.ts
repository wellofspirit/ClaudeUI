import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { logger } from '../services/logger'
import type { SkillInfo } from '../../shared/types'
import type { Agent_Info, Skill_Info } from './protocol-v2/openapi'
import { evaluateV2Call } from './wildcard'
import { safeSkillCatalog } from './claude-skill-bridge'
import { claudeSkillEntryToInfo } from '../services/claude-skill-info'

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
 * Mirrors model-discovery.ts: acquire → fetch → release, degrade to [] on any
 * failure (opencode is optional — Claude must not break). Not cached: the list
 * follows the cwd's skill files, and the Skills dialog is opened rarely.
 *
 * opencode 2.x `Skill.Info { id, name, description?, path, content }` → SkillInfo. A skill
 * the plugin added from the shared Claude catalog (its id is a catalog name AND its path is
 * the catalog entry's file: an engine skill of the same id wins the clash and keeps its own
 * path) carries the catalog's source, kind, invocation flags and `claudeOnly`; every other
 * one is the engine's own (`source: 'engine'`).
 */
export async function discoverOpencodeSkills(cwd: string): Promise<SkillInfo[]> {
  try {
    // Lists only — no turn, so no wait for the hosted MCP tools.
    const conn = await opencodeServerManager.acquire(cwd, { waitForHostedTools: false })
    const client = new OpencodeClient(conn)
    try {
      const skills = await client.skills()
      // A skill every agent denies is not offered to any model: do not offer it here.
      const agents = await client.agents().catch(() => [] as readonly Agent_Info[])
      const catalog = new Map(safeSkillCatalog(cwd).entries.map((e) => [e.name, e]))
      return skills
        .filter((s) => !noAgentOffers(s, agents))
        .map((s): SkillInfo => {
          const entry = catalog.get(s.id)
          if (!entry || entry.file !== s.path)
            return {
              name: s.name,
              displayName: s.name,
              description: s.description ?? '',
              source: 'engine',
              path: s.path,
              content: s.content
            }
          return claudeSkillEntryToInfo(entry, { includeClaudeOnly: true })
        })
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
