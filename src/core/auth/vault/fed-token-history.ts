/**
 * Which ChatGPT refresh tokens ClaudeUI put into each engine's auth store, or
 * adopted from it as a rotation of its own copy (ADR-082 §8, "As built (S7e)"),
 * so a disconnect can tell a STALE copy of ClaudeUI's — the vault rotated while
 * the harness did not run — from a sign-in made in the harness itself.
 *
 * Only SHA-256 fingerprints are stored, never a token, in ClaudeUI's own file
 * (`~/.claude/ui/chatgpt-fed-token-fingerprints.json`, 0600), the last
 * {@link FED_TOKEN_HISTORY_CAP} per engine. An engine with no history — every
 * engine of an install from before this file — falls back to the rule that
 * preceded it: only the vault's tokens are ClaudeUI's.
 *
 * It decides REMOVALS only: feeding and adoption never read it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '../../services/logger'
import { readJsonFileForWrite, writeJsonAtomic } from '../../services/write-json-atomic'
import { keyFingerprint } from '../../services/secret-fingerprint'

type Engine = 'pi' | 'opencode'
type Records = Partial<Record<Engine, string[]>>

/** Fingerprints kept per engine; the oldest go first. */
export const FED_TOKEN_HISTORY_CAP = 32

export interface FedTokenHistory {
  /** `refreshToken` is one ClaudeUI put into (or adopted from) `engine`. */
  holds(engine: Engine, refreshToken: string): boolean
  record(engine: Engine, refreshToken: string): void
  /** ClaudeUI's copy is out of `engine`: nothing there is ClaudeUI's any more. */
  forget(engine: Engine): void
}

/** `list` with `fingerprint` appended last (moved there if present), capped. */
function appended(list: readonly string[] | undefined, fingerprint: string): string[] {
  return [...(list ?? []).filter((entry) => entry !== fingerprint), fingerprint].slice(
    -FED_TOKEN_HISTORY_CAP
  )
}

function defaultPath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'chatgpt-fed-token-fingerprints.json')
}

/** The store over `filePath` (default resolved per call, so a test home applies). */
export function fedTokenHistory(filePath?: string): FedTokenHistory {
  const file = (): string => filePath ?? defaultPath()
  const read = (): Records => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Records) : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('FedTokenHistory', `unreadable ${file()}: ${(error as Error).message}`)
      return {}
    }
  }
  const list = (engine: Engine): string[] => {
    const value = read()[engine]
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
  }
  const update = (change: (records: Records) => void): void => {
    const records = readJsonFileForWrite(file()) as Records
    change(records)
    writeJsonAtomic(file(), records, { indent: 2 })
  }
  return {
    holds: (engine, refreshToken) => list(engine).includes(keyFingerprint(refreshToken)),
    record: (engine, refreshToken) => {
      const fingerprint = keyFingerprint(refreshToken)
      const current = list(engine)
      if (current[current.length - 1] === fingerprint) return
      update((records) => {
        records[engine] = appended(current, fingerprint)
      })
    },
    forget: (engine) => {
      if (list(engine).length === 0) return
      update((records) => {
        delete records[engine]
      })
    }
  }
}

/** An in-memory store: the default when none is wired (tests); production wires the file. */
export function memoryFedTokenHistory(): FedTokenHistory {
  const records: Records = {}
  return {
    holds: (engine, refreshToken) =>
      records[engine]?.includes(keyFingerprint(refreshToken)) === true,
    record: (engine, refreshToken) => {
      records[engine] = appended(records[engine], keyFingerprint(refreshToken))
    },
    forget: (engine) => {
      delete records[engine]
    }
  }
}
