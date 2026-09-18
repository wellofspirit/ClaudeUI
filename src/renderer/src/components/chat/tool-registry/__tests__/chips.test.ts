/**
 * toolChips — the ToolCard header's metadata strip.
 *
 * The invariant under test is honesty (ADR-030): a chip appears only when the
 * value was PROVED by the result or is computable from what the view already
 * holds. An engine that does not report a fact renders no chip for it — never a
 * placeholder, never a zero standing in for unknown.
 */

import { describe, it, expect } from 'vitest'
import { toolChips, searchResultChips } from '../chips'
import type { ToolView } from '../../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

function ok(text: string): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 't', toolResult: text }
}
function err(text: string): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 't', toolResult: text, isError: true }
}
const labels = (view: ToolView, kind: ToolView['kind'], result?: ToolResultBlock): string[] =>
  toolChips(kind, view, result).map((c) => c.label)

describe('toolChips — command', () => {
  it('shows no exit chip for an engine that does not report one (Claude Bash)', () => {
    const view: ToolView = { kind: 'command', command: 'ls', output: 'a\nb' }
    expect(toolChips('command', view, ok('a\nb'))).toEqual([])
  })

  it('shows `exit 0` in the success tone when the engine reports zero', () => {
    const view: ToolView = { kind: 'command', command: 'ls', exitCode: 0 }
    expect(toolChips('command', view, ok(''))).toEqual([{ label: 'exit 0', tone: 'ok' }])
  })

  it('shows a non-zero exit in the error tone', () => {
    const view: ToolView = { kind: 'command', command: 'false', exitCode: 2 }
    expect(toolChips('command', view, err(''))).toEqual([{ label: 'exit 2', tone: 'error' }])
  })
})

describe('toolChips — file kinds', () => {
  it('counts an edit as +added −removed and names the language', () => {
    const view: ToolView = {
      kind: 'fileEdit',
      path: 'src/a.ts',
      before: 'one\ntwo',
      after: 'one\ntwo\nthree'
    }
    expect(labels(view, 'fileEdit', ok(''))).toEqual(['+3 −2', 'typescript'])
  })

  it('prefers an engine-supplied additions/deletions count over counting hunks', () => {
    const view: ToolView = {
      kind: 'fileEdit',
      path: '',
      before: '',
      after: '',
      files: [{ path: 'a.ts', patch: '+x\n-y\n-z', additions: 10, deletions: 3 }]
    }
    expect(labels(view, 'fileEdit', ok(''))).toEqual(['+10 −3', 'typescript'])
  })

  it('counts hunk lines when the engine supplies no totals, skipping file headers', () => {
    const view: ToolView = {
      kind: 'fileEdit',
      path: '',
      before: '',
      after: '',
      files: [{ path: 'a.py', patch: '--- a/a.py\n+++ b/a.py\n+added\n-removed\n context' }]
    }
    expect(labels(view, 'fileEdit', ok(''))).toEqual(['+1 −1', 'python'])
  })

  it('drops the delta chip when the edit errored, keeping the language', () => {
    const view: ToolView = { kind: 'fileEdit', path: 'src/a.ts', before: 'x', after: 'y' }
    expect(labels(view, 'fileEdit', err('String not found'))).toEqual(['typescript'])
  })

  it('states a write size in lines', () => {
    const view: ToolView = { kind: 'fileWrite', path: 'notes.md', content: 'a\nb\nc\n' }
    expect(labels(view, 'fileWrite', ok(''))).toEqual(['3 lines', 'markdown'])
  })

  it('marks a truncated read and never claims truncation otherwise', () => {
    const truncated: ToolView = { kind: 'fileRead', path: 'a.ts', content: 'x', truncated: true }
    expect(labels(truncated, 'fileRead', ok('x'))).toEqual(['truncated', 'typescript'])
    const whole: ToolView = { kind: 'fileRead', path: 'a.ts', content: 'x' }
    expect(labels(whole, 'fileRead', ok('x'))).toEqual(['typescript'])
  })

  it('omits the language chip for a path it cannot place', () => {
    const view: ToolView = { kind: 'fileRead', path: 'LICENSE', content: 'x' }
    expect(labels(view, 'fileRead', ok('x'))).toEqual([])
  })
})

describe('searchResultChips', () => {
  it('reads a "Found N files" header', () => {
    expect(searchResultChips('Found 4 files\na.ts\nb.ts')).toEqual([
      { label: '4 files', tone: 'neutral' }
    ])
  })

  it('singularises a one-item header', () => {
    expect(searchResultChips('Found 1 file\na.ts')).toEqual([{ label: '1 file', tone: 'neutral' }])
  })

  it('counts distinct files and hits for content-mode output', () => {
    const text = 'src/a.ts:12:match one\nsrc/a.ts:40:match two\nsrc/b.ts:3:match three'
    expect(searchResultChips(text)).toEqual([
      { label: '2 files', tone: 'neutral' },
      { label: '3 hits', tone: 'neutral' }
    ])
  })

  it('counts lines as files for a bare path list (Glob, files_with_matches)', () => {
    expect(searchResultChips('src/a.ts\nsrc/b.ts')).toEqual([{ label: '2 files', tone: 'neutral' }])
  })

  it('says so when nothing matched', () => {
    expect(searchResultChips('')).toEqual([])
    expect(searchResultChips('   \n  ')).toEqual([{ label: 'no matches', tone: 'neutral' }])
  })
})

describe('toolChips — in-flight and error calls', () => {
  it('claims nothing about a result that has not landed', () => {
    const view: ToolView = { kind: 'search', query: 'x' }
    expect(toolChips('search', view, undefined)).toEqual([])
  })

  it('claims no search counts when the search itself failed', () => {
    const view: ToolView = { kind: 'search', query: 'x' }
    expect(toolChips('search', view, err('bad pattern'))).toEqual([])
  })

  it('marks an MCP tool read-only only when the server said so', () => {
    const declared: ToolView = { kind: 'mcp', input: {}, server: 's', tool: 't', readOnly: true }
    expect(labels(declared, 'mcp', ok(''))).toEqual(['read-only'])
    const silent: ToolView = { kind: 'mcp', input: {}, server: 's', tool: 't' }
    expect(labels(silent, 'mcp', ok(''))).toEqual([])
  })

  it('counts web results only when the wire carried structured rows', () => {
    const structured: ToolView = {
      kind: 'web',
      target: 'q',
      results: [
        { title: 'a', url: 'https://a' },
        { title: 'b', url: 'https://b' }
      ]
    }
    expect(labels(structured, 'web', ok(''))).toEqual(['2 results'])
    const plain: ToolView = { kind: 'web', target: 'q' }
    expect(labels(plain, 'web', ok('some prose'))).toEqual([])
  })
})
