import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { logger } from '../services/logger'
import type { SkillInfo } from '../../shared/types'

// Per-cwd cache of discovered skills. Keyed by normalized absolute cwd.
const skillCache = new Map<string, SkillInfo[]>()

/**
 * Discover opencode skills for a given working directory by spinning up a
 * transient server, calling GET /skill, mapping the result to SkillInfo[], then
 * releasing the server.
 *
 * Mirrors model-discovery.ts: acquire → fetch → release, cwd-keyed cache,
 * degrade to [] on any failure (opencode is optional — Claude must not break).
 *
 * opencode `{ name, description?, location, content }` → SkillInfo with
 * `source: 'project'` (closest valid union value — opencode unifies project/user
 * sources; the dialog renders them identically, so the distinction doesn't matter).
 */
export async function discoverOpencodeSkills(cwd: string): Promise<SkillInfo[]> {
  const hit = skillCache.get(cwd)
  if (hit) return hit

  try {
    const conn = await opencodeServerManager.acquire(cwd)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      const skills = await client.listSkills()
      const result: SkillInfo[] = skills.map((s) => ({
        name: s.name,
        displayName: s.name,
        description: s.description ?? '',
        // opencode doesn't expose a source taxonomy — use 'project' as a neutral
        // "available in this workspace" value (all valid SkillSource values render
        // identically in the Skills dialog).
        source: 'project' as const,
        path: s.location,
        content: s.content
      }))
      skillCache.set(cwd, result)
      return result
    } finally {
      opencodeServerManager.release(cwd)
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
