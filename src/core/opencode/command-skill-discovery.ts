import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { logger } from '../services/logger'
import type { SkillInfo } from '../../shared/types'

// Per-cwd cache of discovered skills. Keyed by normalized absolute cwd.
const skillCache = new Map<string, SkillInfo[]>()

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
      const result: SkillInfo[] = skills.map((s) => ({
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
