/**
 * An in-memory filesystem for `pi-path-scope`'s `PathScopeFs` seam: directories, files, symbolic
 * links, unreadable entries — with win32 or POSIX path semantics chosen by the caller, so the
 * Windows and POSIX halves of the containment logic are testable on any host.
 *
 * Only what `landingOf` / the facts ask: `realpath`, `lstat`, `exists`. Link targets are resolved
 * against the link's directory; a chain longer than 40 hops is ELOOP; a missing entry is ENOENT
 * (ENOTDIR under a file); an entry in `denied` is EACCES.
 */
import path from 'node:path'
import type { PathScopeFs } from '../../core/pi/pi-path-scope'

export type VirtualNode = 'dir' | 'file' | { link: string }

export interface VirtualFs extends PathScopeFs {
  /** Add or replace an entry (a live edit, for the swap-between-ask-and-approval tests). */
  set(p: string, node: VirtualNode): void
  /** Remove an entry. */
  remove(p: string): void
}

function errno(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code })
}

export function makeVirtualFs(
  platform: 'win32' | 'posix',
  nodes: Record<string, VirtualNode>,
  options: { denied?: readonly string[] } = {}
): VirtualFs {
  const flavor = platform === 'win32' ? path.win32 : path.posix
  const key = (p: string): string => {
    const abs = flavor.resolve(p)
    return platform === 'win32' ? abs.toLowerCase() : abs
  }
  const table = new Map<string, VirtualNode>()
  for (const [p, node] of Object.entries(nodes)) table.set(key(p), node)
  const denied = new Set((options.denied ?? []).map(key))

  const split = (abs: string): { root: string; parts: string[] } => {
    const { root } = flavor.parse(abs)
    return {
      root,
      parts: abs
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean)
    }
  }

  /** Walk `abs`; follow every link except (optionally) the last component. */
  const walk = (abs: string, followLast: boolean): { real: string; node: VirtualNode } => {
    const first = split(flavor.resolve(abs))
    let { root } = first
    let parts = first.parts
    let current = root
    let node: VirtualNode = 'dir'
    let hops = 0
    while (parts.length > 0) {
      const [name, ...rest] = parts
      const next = flavor.join(current, name)
      if (denied.has(key(next))) throw errno('EACCES', next)
      const found = table.get(key(next))
      if (found === undefined) throw errno(node === 'file' ? 'ENOTDIR' : 'ENOENT', next)
      if (node === 'file') throw errno('ENOTDIR', next)
      if (typeof found === 'object' && (rest.length > 0 || followLast)) {
        if (++hops > 40) throw errno('ELOOP', next)
        const target = split(flavor.resolve(current, found.link))
        root = target.root
        current = root
        parts = [...target.parts, ...rest]
        node = 'dir'
        continue
      }
      current = next
      node = found
      parts = rest
    }
    return { real: current, node }
  }

  return {
    realpath: (p) => walk(p, true).real,
    lstat: (p) => {
      const { node } = walk(p, false)
      return { isSymbolicLink: () => typeof node === 'object' }
    },
    exists: (p) => {
      try {
        walk(p, true)
        return true
      } catch {
        return false
      }
    },
    set: (p, node) => {
      table.set(key(p), node)
    },
    remove: (p) => {
      table.delete(key(p))
    }
  }
}
