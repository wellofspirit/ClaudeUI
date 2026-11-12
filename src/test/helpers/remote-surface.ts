/**
 * The checked-in dump of the STATIC remote command surface: every channel
 * `registerRemoteHandlers` registers for the `remote` transport, with its
 * declaration (capability, kind and the three routing flags).
 *
 * Not "the whole remote surface": the plugin manager registers
 * `plugin:<id>:<channel>` channels at runtime (`plugin-manager.ts`), which no
 * test sees and this dump does not list.
 *
 * One JSON Lines file, one channel per line in plain `sort()` order. It is read
 * with `fs` + `JSON.parse`, never through vitest's snapshot API, so `vitest -u`
 * cannot rewrite it; only {@link REMOTE_SURFACE_UPDATE_COMMAND} does.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Capability, CommandKind, CommandRegistry } from '../../core/ipc/command-registry'

export interface RemoteSurfaceEntry {
  channel: string
  capability: Capability
  kind: CommandKind
  sessionIdArg: 0 | null
  withConnection: boolean
  withProgress: boolean
}

export const REMOTE_SURFACE_PATH = resolve(
  __dirname,
  '../../core/ipc/__tests__/remote-surface.jsonl'
)

export const REMOTE_SURFACE_UPDATE_COMMAND =
  'UPDATE_REMOTE_SURFACE=1 bunx vitest run src/core/ipc/__tests__/remote-handlers.ipc.test.ts -t "checked-in dump"'

const KEYS = [
  'channel',
  'capability',
  'kind',
  'sessionIdArg',
  'withConnection',
  'withProgress'
] as const

/** One entry per `remote` channel, in `registry.channels('remote')` order. */
export function describeRemoteSurface(
  registry: Pick<CommandRegistry, 'channels' | 'declaration'>
): RemoteSurfaceEntry[] {
  return registry.channels('remote').map((channel) => {
    const d = registry.declaration(channel)
    if (!d) throw new Error(`remote channel ${channel} has no declaration`)
    return {
      channel,
      capability: d.capability,
      kind: d.kind,
      sessionIdArg: d.sessionIdArg,
      withConnection: d.withConnection,
      withProgress: d.withProgress
    }
  })
}

/** The exact file text: one compact JSON line per entry, LF, trailing newline. */
export function serializeRemoteSurface(entries: readonly RemoteSurfaceEntry[]): string {
  return entries
    .map((e) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, e[k]]))) + '\n')
    .join('')
}

/** Parse the dump; throws (with the line number) on anything a regeneration would not write. */
export function readRemoteSurface(): RemoteSurfaceEntry[] {
  const lines = readFileSync(REMOTE_SURFACE_PATH, 'utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const entries: RemoteSurfaceEntry[] = []
  const seen = new Set<string>()
  lines.forEach((line, i) => {
    const where = `${REMOTE_SURFACE_PATH}:${i + 1}`
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`${where}: malformed JSON line`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${where}: not a JSON object`)
    }
    if (Object.keys(parsed).join(',') !== KEYS.join(',')) {
      throw new Error(`${where}: keys must be exactly ${KEYS.join(', ')}, in that order`)
    }
    const entry = parsed as RemoteSurfaceEntry
    if (seen.has(entry.channel)) throw new Error(`${where}: duplicate channel ${entry.channel}`)
    seen.add(entry.channel)
    const prev = entries[entries.length - 1]
    if (prev && !(prev.channel < entry.channel)) {
      throw new Error(`${where}: ${entry.channel} is out of sort() order after ${prev.channel}`)
    }
    entries.push(entry)
  })
  return entries
}
