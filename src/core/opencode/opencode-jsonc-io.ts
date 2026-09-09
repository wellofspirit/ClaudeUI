/**
 * opencode-jsonc-io.ts
 *
 * Tiny shared filesystem/jsonc helpers used by BOTH the projection writer
 * (opencode-config.ts, ADR-031) and the raw leaf-patch writer
 * (opencode-native-raw.ts). Extracted so the two writers share one EOL-detection,
 * safe-read, safe-parse, and byte-compare-write-gate discipline rather than
 * duplicating it.
 *
 * These are pure infrastructure — no opencode-specific projection logic lives
 * here. Which is why pi's raw settings writer (`core/pi/pi-native-raw.ts`)
 * imports them too rather than growing a second copy: the file keeps its
 * opencode-flavoured NAME and location so the two shipped writers stay where
 * their readers expect them, but its contents are engine-neutral.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse as jsoncParse } from 'jsonc-parser'

/** Detect line ending from existing content, defaulting to '\n'. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Read a file, returning undefined on any error. */
export function safeRead(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/** jsonc-parse that never throws (returns undefined on error). */
export function jsoncParseSafe(text: string): unknown {
  try {
    return jsoncParse(text)
  } catch {
    return undefined
  }
}

/**
 * Byte-compare write gate: only write (and mkdir the parent) when `text` differs
 * from what is already on disk. Returns whether a write happened. A no-op save
 * (text === originalText) never touches the filesystem — no rewrite, no reformat
 * churn, no comment reflow.
 */
export function writeIfChanged(
  filePath: string,
  text: string,
  originalText: string | undefined
): boolean {
  if (text === originalText) return false
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, text, 'utf8')
  return true
}
