/**
 * @vitest-environment node
 *
 * Structural guard (ADR-087): the replicated lanes carry blob REFS, never bytes.
 *
 * `base64Data` is the name of an upload's payload (`AttachmentUpload`) and of
 * nothing else the transcript may hold. If it reappears in the sync layer —
 * reducer, events, state, the item-stream machinery — some event, queue
 * broadcast or snapshot field has started typing image bytes again, and the next
 * screenshot-heavy session is a 273 MB `sync-full`. The behavioural twin of this
 * test is `core/sync/__tests__/snapshot-blob-size.unit.test.ts`; this one fails
 * at the line that reintroduces the field rather than at the size it causes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SYNC_DIR = join(process.cwd(), 'src', 'core', 'shared', 'sync')

const posixRelative = (path: string): string => relative(SYNC_DIR, path).split(sep).join('/')

/** Every non-test source file under the sync layer. */
function syncSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return syncSources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('src/core/shared/sync carries no inline image bytes', () => {
  const sources = syncSources(SYNC_DIR)

  it('finds the sync layer it is guarding', () => {
    const names = sources.map((s) => posixRelative(s))
    expect(names).toEqual(expect.arrayContaining(['reducer.ts', 'events.ts', 'state.ts']))
  })

  it.each(sources.map((s) => [posixRelative(s), s]))('%s never names base64Data', (_name, path) => {
    expect(readFileSync(path, 'utf8')).not.toContain('base64Data')
  })
})
