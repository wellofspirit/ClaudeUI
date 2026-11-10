import { useEffect, useState } from 'react'
import type { EngineId, SlashCommandInfo } from '../../../shared/types'

/**
 * The `/` menu of a session that has no list of its own yet (a draft: it exists only in the
 * renderer until its first message). Built from the IPCs the host already answers (remote and
 * web alike): Claude's last-known built-ins first (Claude only: another engine's list never
 * fits), then the catalog's user-invocable skills for `cwd`; the first list wins a name.
 * Once per (cwd, engine); a superseded response is dropped; a failure is an empty list.
 */
export function useFallbackSlashCommands(
  cwd: string | null | undefined,
  engineId: EngineId,
  enabled: boolean
): SlashCommandInfo[] {
  const [loaded, setLoaded] = useState<{ key: string; commands: SlashCommandInfo[] } | null>(null)
  const key = `${engineId}\n${cwd ?? ''}`

  useEffect(() => {
    if (!enabled || !cwd) return
    let stale = false
    const builtIns = engineId === 'claude' ? softList(() => window.api.loadSlashCommands()) : null
    const skills = softList(() => window.api.loadSkillDetails(null, cwd)).then((list) =>
      list
        .filter((s) => s.userInvocable !== false)
        .map((s) => ({
          name: '/' + s.name,
          ...(s.description ? { description: s.description } : {})
        }))
    )
    void Promise.all([builtIns ?? [], skills]).then(([base, extra]) => {
      if (stale) return
      const seen = new Set(base.map((c) => c.name))
      setLoaded({ key, commands: [...base, ...extra.filter((c) => !seen.has(c.name))] })
    })
    return () => {
      stale = true
    }
  }, [enabled, cwd, engineId, key])

  return loaded?.key === key ? loaded.commands : NO_COMMANDS
}

/** A list from the host; a throw, a rejection or a non-list is an empty list. */
async function softList<T>(read: () => Promise<T[]> | T[]): Promise<T[]> {
  try {
    const list = await read()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

const NO_COMMANDS: SlashCommandInfo[] = []
