import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeUserAgentsDir,
  harnessField,
  MAX_AGENT_FILE_BYTES,
  MAX_AGENT_FILES_PER_DIR,
  parseAgentDocument,
  parseToolList,
  projectDirChain,
  readNameAndDescription,
  samePathKey,
  scanAgentDir
} from '../agent-defs'

// Every file and directory this suite creates is recorded and removed by its
// explicit name afterwards (files first, then directories deepest-first).
let base: string
const createdFiles: string[] = []
const createdDirs: string[] = []

function mkdir(p: string): string {
  const parts: string[] = []
  let cur = p
  while (!fs.existsSync(cur)) {
    parts.unshift(cur)
    cur = path.dirname(cur)
  }
  for (const d of parts) {
    fs.mkdirSync(d)
    createdDirs.push(d)
  }
  return p
}

function write(p: string, text: string): string {
  mkdir(path.dirname(p))
  fs.writeFileSync(p, text)
  createdFiles.push(p)
  return p
}

const doc = (fields: string, body = 'The prompt.'): string => `---\n${fields}\n---\n${body}\n`

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-'))
  createdDirs.push(base)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const f of createdFiles.splice(0)) fs.unlinkSync(f)
  for (const d of createdDirs.splice(0).reverse()) fs.rmdirSync(d)
})

describe('parseAgentDocument', () => {
  it('splits the front matter and trims the body; accepts a BOM and CRLF', () => {
    const r = parseAgentDocument('﻿---\r\nname: a\r\n---\r\n\r\n  Do the thing.  \r\n')
    expect(r).toEqual({ data: { name: 'a' }, body: 'Do the thing.' })
  })

  it('refuses anything that is not plain front matter, without evaluating it', () => {
    for (const text of [
      '---js\n(globalThis).__defsPwned = true\n---\nbody',
      '---yaml\nname: a\n---\nbody',
      'name: a\n---\nbody',
      ' ---\nname: a\n---\nbody',
      ''
    ]) {
      expect(parseAgentDocument(text)).toEqual({
        error: 'no front matter (the first line must be exactly ---)'
      })
    }
    expect((globalThis as Record<string, unknown>).__defsPwned).toBeUndefined()
    expect(parseAgentDocument('---\nname: a\n')).toEqual({ error: 'unterminated front matter' })
  })

  it('refuses an alias bomb, a duplicate key and a non-map, with reasons and no contents', () => {
    const bomb = parseAgentDocument(doc('a: &a ["x","x"]\nb: &b [*a,*a]\nc: [*b,*b]'))
    expect(bomb).toMatchObject({ error: expect.stringMatching(/Alias resolution is disabled/) })
    expect(parseAgentDocument(doc('name: a\nname: b'))).toMatchObject({
      error: expect.stringMatching(/^invalid front matter/)
    })
    expect(parseAgentDocument(doc('- a\n- b'))).toEqual({
      error: 'front matter is not a key/value map'
    })
    expect(parseAgentDocument(doc('just a string'))).toEqual({
      error: 'front matter is not a key/value map'
    })
  })
})

describe('readNameAndDescription', () => {
  it('validates the name and collapses the description', () => {
    expect(readNameAndDescription({ name: 'My Agent', description: 'a\n  b' })).toEqual({
      name: 'My Agent',
      description: 'a b'
    })
    expect(readNameAndDescription({ description: 'd' })).toEqual({
      error: 'missing or invalid name'
    })
    expect(readNameAndDescription({ name: '-bad', description: 'd' })).toEqual({
      error: 'missing or invalid name'
    })
    expect(readNameAndDescription({ name: 'a'.repeat(65), description: 'd' })).toEqual({
      error: 'missing or invalid name'
    })
    expect(readNameAndDescription({ name: 'a', description: '  ' })).toEqual({
      error: 'a: missing description'
    })
  })
})

describe('parseToolList', () => {
  const warnings: string[] = []
  const warn = (m: string): void => void warnings.push(m)
  beforeEach(() => void warnings.splice(0))

  it('reads a comma string or a list; * inherits; absent is absent; wrong types are null', () => {
    expect(parseToolList(undefined, 'tools', warn)).toEqual({ kind: 'absent' })
    expect(parseToolList('Read, Grep,,Read', 'tools', warn)).toEqual({
      kind: 'list',
      tools: ['Read', 'Grep']
    })
    expect(parseToolList(['Read', '*'], 'tools', warn)).toEqual({ kind: 'inherit' })
    expect(parseToolList('', 'tools', warn)).toEqual({ kind: 'list', tools: [] })
    expect(parseToolList({ a: 1 }, 'tools', warn)).toBeNull()
    expect(parseToolList(7, 'tools', warn)).toBeNull()
  })

  it('maps names (then de-duplicates) and drops what is not a tool name, with a diagnostic', () => {
    const map = (n: string): string => (n.toLowerCase() === 'glob' ? 'find' : n)
    expect(
      parseToolList(
        ['Glob', 'find', 'Bash(git *)', '-x', '+y', 3, 'mcp__gh__x'],
        'tools',
        warn,
        map
      )
    ).toEqual({ kind: 'list', tools: ['find', 'mcp__gh__x'] })
    expect(warnings).toEqual([
      'tools: ignored an entry that is not a tool name',
      'tools: ignored an entry that is not a tool name',
      'tools: ignored an entry that is not a tool name',
      'tools: ignored a non-string entry'
    ])
  })
})

describe('harnessField', () => {
  const warnings: string[] = []
  const warn = (m: string): void => void warnings.push(m)
  beforeEach(() => void warnings.splice(0))

  it('reads harness.<harness>.<key>; absent levels are silent', () => {
    const data = { harness: { pi: { model: 'a/b' }, opencode: { model: 'c/d' } } }
    expect(harnessField(data, 'pi', 'model', warn)).toBe('a/b')
    expect(harnessField(data, 'opencode', 'model', warn)).toBe('c/d')
    expect(harnessField(data, 'pi', 'other', warn)).toBeUndefined()
    expect(harnessField({}, 'pi', 'model', warn)).toBeUndefined()
    expect(harnessField({ harness: { opencode: {} } }, 'pi', 'model', warn)).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('a level that is not a map is ignored with a warning', () => {
    expect(harnessField({ harness: 'pi' }, 'pi', 'model', warn)).toBeUndefined()
    expect(harnessField({ harness: ['pi'] }, 'pi', 'model', warn)).toBeUndefined()
    expect(harnessField({ harness: { pi: 'a/b' } }, 'pi', 'model', warn)).toBeUndefined()
    expect(warnings).toEqual([
      'harness is not a key/value map; ignored',
      'harness is not a key/value map; ignored',
      'harness.pi is not a key/value map; ignored'
    ])
  })

  it('reads own keys only (no prototype pollution through the YAML)', () => {
    const parsed = parseAgentDocument(doc('name: a\nharness:\n  __proto__:\n    model: evil/x'))
    if ('error' in parsed) throw new Error(parsed.error)
    expect(harnessField(parsed.data, 'pi', 'model', warn)).toBeUndefined()
    expect(({} as Record<string, unknown>).model).toBeUndefined()
    // An inherited key (here from Object.prototype) is not read either.
    expect(harnessField({ harness: {} }, 'pi', 'toString', warn)).toBeUndefined()
    expect(harnessField({ harness: { pi: {} } }, 'pi', 'toString', warn)).toBeUndefined()
  })
})

describe('scanAgentDir', () => {
  const parse = (text: string): { text: string } | { error: string } =>
    text.startsWith('bad') ? { error: 'nope' } : { text }

  it('reads *.md files sorted, skipping what cannot be a definition, and reports why', () => {
    const dir = mkdir(path.join(base, 'agents'))
    write(path.join(dir, 'b.md'), 'B')
    write(path.join(dir, 'a.MD'), 'A')
    write(path.join(dir, 'notes.txt'), 'ignored')
    write(path.join(dir, 'bad.md'), 'bad')
    const big = write(path.join(dir, 'big.md'), 'x'.repeat(MAX_AGENT_FILE_BYTES + 1))
    const folder = mkdir(path.join(dir, 'folder.md'))
    const diagnostics: string[] = []
    expect(scanAgentDir(dir, diagnostics, parse)).toEqual([{ text: 'A' }, { text: 'B' }])
    expect(diagnostics).toEqual([
      `${path.join(dir, 'bad.md')}: skipped (nope)`,
      `${big}: skipped (larger than ${MAX_AGENT_FILE_BYTES} bytes)`,
      `${folder}: skipped (not a regular file)`
    ])
  })

  it('reads at most MAX_AGENT_FILES_PER_DIR files and says so', () => {
    const dir = mkdir(path.join(base, 'many'))
    const total = MAX_AGENT_FILES_PER_DIR + 3
    for (let i = 0; i < total; i++) write(path.join(dir, `a${String(i).padStart(3, '0')}.md`), 'x')
    const diagnostics: string[] = []
    expect(scanAgentDir(dir, diagnostics, parse)).toHaveLength(MAX_AGENT_FILES_PER_DIR)
    expect(diagnostics).toEqual([
      `${dir}: ${total} definition files, only the first ${MAX_AGENT_FILES_PER_DIR} are read`
    ])
  })

  it('a missing directory, or a path that is a file, is silent', () => {
    const diagnostics: string[] = []
    expect(scanAgentDir(path.join(base, 'nope'), diagnostics, parse)).toEqual([])
    const file = write(path.join(base, 'file'), 'x')
    expect(scanAgentDir(file, diagnostics, parse)).toEqual([])
    expect(diagnostics).toEqual([])
  })

  it('a parser that throws becomes a diagnostic, never an exception', () => {
    const dir = mkdir(path.join(base, 'throws'))
    write(path.join(dir, 'a.md'), 'x')
    const diagnostics: string[] = []
    expect(
      scanAgentDir(dir, diagnostics, () => {
        throw Object.assign(new Error('boom'), { code: 'EBOOM' })
      })
    ).toEqual([])
    expect(diagnostics).toEqual([`${path.join(dir, 'a.md')}: skipped (EBOOM)`])
  })
})

describe('project and user directories', () => {
  it('projectDirChain: root (the nearest .git, a file counts) first, cwd last; no .git means cwd alone', () => {
    const root = mkdir(path.join(base, 'wt'))
    write(path.join(root, '.git'), 'gitdir: /elsewhere\n')
    const cwd = mkdir(path.join(root, 'a', 'b'))
    expect(projectDirChain(cwd)).toEqual([root, path.join(root, 'a'), cwd])
    expect(projectDirChain(root)).toEqual([root])
    // No .git between here and the filesystem root of the walk: just the dir (the tmp dir itself
    // may sit under a repository on some machines, so only assert the cwd comes last).
    expect(projectDirChain(cwd).at(-1)).toBe(cwd)
  })

  it('claudeUserAgentsDir is ~/.claude/agents, read at call time', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(base, 'h1'))
    expect(claudeUserAgentsDir()).toBe(path.join(base, 'h1', '.claude', 'agents'))
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(base, 'h2'))
    expect(claudeUserAgentsDir()).toBe(path.join(base, 'h2', '.claude', 'agents'))
  })

  it('samePathKey ignores trailing separators and dot segments', () => {
    expect(samePathKey(path.join(base, 'x', '..', 'y'))).toBe(samePathKey(path.join(base, 'y')))
    expect(samePathKey(path.join(base, 'y') + path.sep)).toBe(samePathKey(path.join(base, 'y')))
  })
})
