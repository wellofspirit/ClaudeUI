/**
 * The mockup-preview channels — ONE declaration, both transports.
 *
 * `cwd` / `directory` are caller-supplied and reachable remotely, so BOTH the read and the
 * recursive watch are confined to a direct child of the project's mockups root (mirrors the
 * HTTP transport's traversal guard in `mockup-protocol.ts`): a crafted `directory`
 * (`'../../..'`) must not traverse out, nor arm a recursive `fs.watch` over an arbitrary tree.
 * The watch guard used to exist on the remote registration only.
 *
 * The watcher map is per FACTORY CALL, i.e. one per registrar, as it always was (the worktree
 * remover reaches across both through `mockup-watch-registry.ts`).
 */

import * as fs from 'fs'
import * as path from 'path'
import { emitEvent } from '../services/sync-host'
import { isPathInside } from '../services/path-containment'
import { trackMockupWatcher } from '../services/mockup-watch-registry'
import type { CommandRegistration, Transport } from './command-registry'
import { envelopeFor } from './safe-handler'

export function mockupCommands(
  transport: Transport
): Array<Omit<CommandRegistration, 'transport'>> {
  const env = envelopeFor(transport)

  const mockupWatchers = new Map<
    string,
    {
      watcher: fs.FSWatcher
      debounceTimer: ReturnType<typeof setTimeout> | null
      untrack: () => void
    }
  >()

  const closeMockupWatcher = (key: string): void => {
    const entry = mockupWatchers.get(key)
    if (!entry) return
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.untrack()
    mockupWatchers.delete(key)
  }

  return [
    {
      channel: 'mockup:read-html',
      capability: 'fs-read',
      kind: 'query',
      handler: env(async (cwd: string, directory: string) => {
        const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
        const mockupDir = path.resolve(path.join(mockupsRoot, directory))
        if (!isPathInside(mockupsRoot, mockupDir)) {
          throw new Error('Invalid mockup directory')
        }
        return fs.promises.readFile(path.join(mockupDir, 'index.html'), 'utf-8')
      })
    },
    {
      channel: 'mockup:watch',
      capability: 'fs-read',
      kind: 'query',
      handler: async (cwd: string, directory: string) => {
        const key = `${cwd}:${directory}`
        if (mockupWatchers.has(key)) return // already watching

        const mockupsRoot = path.resolve(path.join(cwd, '.claude', 'ui', 'mockups'))
        const dirPath = path.resolve(path.join(mockupsRoot, directory))
        if (!isPathInside(mockupsRoot, dirPath)) return
        if (!fs.existsSync(dirPath)) return

        const entry = {
          watcher: null! as fs.FSWatcher,
          debounceTimer: null as ReturnType<typeof setTimeout> | null,
          untrack: (): void => {}
        }

        // Recursive so edits to sibling subdirs (e.g. `images/hero.png`, `components/card.css`)
        // also trigger reloads. Debounced so editors that atomic-write via temp-file + rename
        // don't fire multiple times. Delivered to every subscriber (SyncCore phase 4c), so a
        // mockup open in a browser live-reloads on edit.
        entry.watcher = fs.watch(dirPath, { recursive: true }, (_event, filename) => {
          if (!filename) return
          if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
          entry.debounceTimer = setTimeout(() => {
            emitEvent('mockup:file-changed', [directory])
          }, 200)
        })

        // Without an 'error' listener a watcher fault (on Windows, deleting the watched dir —
        // a worktree removal — raises one asynchronously) becomes a process-level
        // uncaughtException, and the dead watcher would stay in the map behind the has() guard
        // above, blocking any re-watch. Drop it.
        entry.watcher.on('error', () => closeMockupWatcher(key))
        // Visible to the worktree remover, which closes the watches under a removed path first.
        entry.untrack = trackMockupWatcher(dirPath, () => closeMockupWatcher(key))

        mockupWatchers.set(key, entry)
      }
    },
    {
      channel: 'mockup:unwatch',
      capability: 'fs-read',
      kind: 'query',
      handler: async (cwd: string, directory: string) => {
        closeMockupWatcher(`${cwd}:${directory}`)
      }
    }
  ]
}
