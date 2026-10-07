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
import {
  parse as jsoncParse,
  modify,
  applyEdits,
  parseTree,
  findNodeAtLocation,
  visit
} from 'jsonc-parser'
import type { FormattingOptions } from 'jsonc-parser'

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
  writeFileAtomic(filePath, text)
  return true
}

/**
 * Replace a file's contents atomically: write a temp file beside it, then
 * rename over it, so a watcher (opencode's own) never reads a half-written
 * config. The existing file's mode is kept, and a SYMLINK is followed (the
 * link stays a link; its target is replaced), as dotfile setups use them.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  let target = filePath
  let mode: number | undefined
  try {
    target = fs.realpathSync(filePath)
    mode = fs.statSync(target).mode & 0o7777
  } catch {
    // a new file: default mode, no link to follow
  }
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`
  )
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
    if (mode !== undefined) fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing left to clean up
    }
    throw err
  }
}

/**
 * A JSONC document under leaf edits: every `set`/`del` is one jsonc-parser
 * `modify()` + `applyEdits` on the current text (comments and untouched
 * siblings byte-preserved), and `get` reads the CURRENT text, so a sequence of
 * edits can depend on the ones before it. `del` of an absent path is a no-op
 * (`modify()` throws deleting under a missing parent).
 */
export class JsoncDoc {
  text: string
  private readonly fmt: FormattingOptions
  private parsed: unknown
  private parsedText: string | null = null

  constructor(text: string) {
    this.text = text
    this.fmt = { insertSpaces: true, tabSize: 2, eol: detectEol(text) }
  }

  /** The current text parsed (`{}` when it is not an object). */
  value(): Record<string, unknown> {
    if (this.parsedText !== this.text) {
      this.parsed = jsoncParseSafe(this.text)
      this.parsedText = this.text
    }
    const v = this.parsed
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  }

  get(path: (string | number)[]): unknown {
    let cur: unknown = this.value()
    for (const seg of path) {
      if (Array.isArray(cur) && typeof seg === 'number') cur = cur[seg]
      else if (typeof cur === 'object' && cur !== null && !Array.isArray(cur))
        cur = Object.prototype.hasOwnProperty.call(cur, String(seg))
          ? (cur as Record<string, unknown>)[String(seg)]
          : undefined
      else return undefined
    }
    return cur
  }

  has(path: (string | number)[]): boolean {
    if (path.length === 0) return true
    const parent = this.get(path.slice(0, -1))
    const last = path[path.length - 1]
    if (Array.isArray(parent)) return typeof last === 'number' && last >= 0 && last < parent.length
    return (
      typeof parent === 'object' &&
      parent !== null &&
      Object.prototype.hasOwnProperty.call(parent, String(last))
    )
  }

  set(path: (string | number)[], value: unknown): void {
    this.text = applyEdits(
      this.text,
      modify(this.text, path, value, { formattingOptions: this.fmt })
    )
  }

  /** Insert `value` into the array at `path` before `index` (append when index = length). */
  insert(path: (string | number)[], index: number, value: unknown): void {
    this.text = applyEdits(
      this.text,
      modify(this.text, [...path, index], value, {
        formattingOptions: this.fmt,
        isArrayInsertion: true
      })
    )
  }

  del(path: (string | number)[]): void {
    if (!this.has(path)) return
    this.text = applyEdits(
      this.text,
      modify(this.text, path, undefined, { formattingOptions: this.fmt })
    )
  }

  /**
   * The comments of the PROPERTY at `path` — its leading comments (after the
   * previous sibling) and every comment inside its value — in text order.
   * jsonc-parser drops all of them when the property is deleted.
   */
  commentsOf(path: (string | number)[]): string[] {
    const root = parseTree(this.text)
    const node = root ? findNodeAtLocation(root, path) : undefined
    const property = node?.parent
    if (!node || !property || property.type !== 'property') return []
    const siblings = property.parent?.children ?? []
    const index = siblings.indexOf(property)
    const start =
      index > 0
        ? siblings[index - 1].offset + siblings[index - 1].length
        : (property.parent?.offset ?? 0) + 1
    const end = property.offset + property.length
    const comments: string[] = []
    visit(this.text, {
      onComment: (offset, length) => {
        if (offset >= start && offset < end) comments.push(this.text.slice(offset, offset + length))
      }
    })
    return comments
  }

  /** Put comments, one per line, right above the property at `path` (same indent). */
  insertCommentsBefore(path: (string | number)[], comments: readonly string[]): void {
    if (comments.length === 0) return
    const root = parseTree(this.text)
    const property = root ? findNodeAtLocation(root, path)?.parent : undefined
    if (!property || property.type !== 'property') return
    const lineStart = this.text.lastIndexOf('\n', property.offset - 1) + 1
    const indent = /^[ \t]*/.exec(this.text.slice(lineStart))?.[0] ?? ''
    const eol = detectEol(this.text)
    const block = comments.map((comment) => `${comment}${eol}${indent}`).join('')
    this.text = this.text.slice(0, property.offset) + block + this.text.slice(property.offset)
  }

  /** Delete the object at `path` when it is present and empty. */
  delIfEmpty(path: (string | number)[]): void {
    const v = this.get(path)
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
      this.del(path)
  }
}
