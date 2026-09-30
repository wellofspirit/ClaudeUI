/**
 * Which API key ClaudeUI last delivered into each harness slot (ADR-082 §8,
 * "As built (S7d)"), so an automatic delivery can tell ClaudeUI's own earlier
 * key from a key the user gave the harness.
 *
 * A slot is a harness and the vendor id its auth store keys the entry on
 * (`pi` + `openrouter`). Keyed by slot rather than by definition, because the
 * slot is what the harness holds and what a removal takes out: a definition
 * removed and added again lands on the same record.
 *
 * Only a SHA-256 fingerprint is stored, never the key, in ClaudeUI's own file
 * (`~/.claude/ui/delivered-key-fingerprints.json`, 0600). A slot with no record
 * — every slot of an install from before this file — falls back to the rule
 * that preceded it: only the vault key is ClaudeUI's. The first delivery after
 * the upgrade records it.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '../services/logger'
import { readJsonFileForWrite, writeJsonAtomic } from '../services/write-json-atomic'

type Route = 'pi' | 'opencode'
type Records = Partial<Record<Route, Record<string, string>>>

export interface DeliveredKeyFingerprints {
  /** `key` is the one ClaudeUI last delivered into this slot. */
  matches(route: Route, vendorId: string, key: string): boolean
  record(route: Route, vendorId: string, key: string): void
  /** The slot's key was taken out: nothing there is ClaudeUI's any more. */
  forget(route: Route, vendorId: string): void
}

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

function defaultPath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'delivered-key-fingerprints.json')
}

/** The store over `filePath` (default resolved per call, so a test home applies). */
export function deliveredKeyFingerprints(filePath?: string): DeliveredKeyFingerprints {
  const file = (): string => filePath ?? defaultPath()
  const read = (): Records => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Records) : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('DeliveredKeys', `unreadable ${file()}: ${(error as Error).message}`)
      return {}
    }
  }
  const update = (change: (records: Records) => void): void => {
    const records = readJsonFileForWrite(file()) as Records
    change(records)
    writeJsonAtomic(file(), records, { indent: 2 })
  }
  return {
    matches: (route, vendorId, key) => read()[route]?.[vendorId] === keyFingerprint(key),
    record: (route, vendorId, key) => {
      const fingerprint = keyFingerprint(key)
      if (read()[route]?.[vendorId] === fingerprint) return
      update((records) => {
        records[route] = { ...records[route], [vendorId]: fingerprint }
      })
    },
    forget: (route, vendorId) => {
      if (read()[route]?.[vendorId] === undefined) return
      update((records) => {
        const slots = { ...records[route] }
        delete slots[vendorId]
        records[route] = slots
      })
    }
  }
}

/** An in-memory store: the default when none is wired (tests); production wires the file. */
export function memoryDeliveredKeyFingerprints(): DeliveredKeyFingerprints {
  const records: Records = {}
  return {
    matches: (route, vendorId, key) => records[route]?.[vendorId] === keyFingerprint(key),
    record: (route, vendorId, key) => {
      records[route] = { ...records[route], [vendorId]: keyFingerprint(key) }
    },
    forget: (route, vendorId) => {
      delete records[route]?.[vendorId]
    }
  }
}
