/**
 * macOS: vet a release zip before `ditto` unpacks it (Critical: ditto keeps
 * symlinks and writes whatever names the archive holds). The archive already
 * matched the signed manifest's sha256, so this is defence in depth against a
 * bad release, read from the zip's own central directory (`listZipEntries`):
 *
 *   - every name is relative, has no `..` (nor empty, `.` or backslash)
 *     segment, and sits under `ClaudeUI.app/`;
 *   - only files, directories and symlinks (no devices, FIFOs);
 *   - no entry's path passes through a symlink entry of the archive (stricter
 *     than "through an earlier one": order does not matter);
 *   - every symlink's target is relative and, resolved inside the archive
 *     (following its other symlinks, bounded), stays inside the bundle. Electron
 *     bundles legitimately hold relative framework links such as
 *     `Versions/Current -> A` and `X.framework/X -> Versions/Current/X`.
 */

import {
  ArchiveError,
  listZipEntries,
  type ZipListing
} from '../../../core/harness/install/archive'

export const BUNDLE = 'ClaudeUI.app'
const MAX_LINK_DEPTH = 32

type Resolved = string[] | null

/** Resolve `target` from directory `from` (segments), following the archive's links; null when it leaves the archive root. */
function resolveLink(
  from: string[],
  target: string,
  links: ReadonlyMap<string, string>,
  depth: number
): Resolved {
  if (depth > MAX_LINK_DEPTH) return null
  if (target === '' || target.includes('\0') || target.includes('\\')) return null
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return null
  const stack = [...from]
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
    const link = links.get(stack.join('/'))
    if (link !== undefined) {
      const resolved = resolveLink(stack.slice(0, -1), link, links, depth + 1)
      if (!resolved) return null
      stack.splice(0, stack.length, ...resolved)
    }
  }
  return stack
}

/** Why the listed archive must not be unpacked, or null. Pure. */
export function vetReleaseEntries(entries: readonly ZipListing[]): string | null {
  if (entries.length === 0) return 'The update archive is empty'
  const paths: Array<{ name: string; segments: string[] }> = []
  const links = new Map<string, string>()
  for (const e of entries) {
    const name = e.name
    if (name.includes('\0') || name.includes('\\'))
      return `The update archive has a malformed name: ${JSON.stringify(name)}`
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
      return `The update archive has an absolute path: ${name}`
    const segments = name.replace(/\/$/, '').split('/')
    if (segments.includes('..')) return `The update archive has a path that climbs out: ${name}`
    if (segments.some((s) => s === '' || s === '.'))
      return `The update archive has a malformed name: ${JSON.stringify(name)}`
    if (segments[0] !== BUNDLE)
      return `The update archive holds something outside ${BUNDLE}: ${name}`
    if (e.type === 'other') return `The update archive holds a special file: ${name}`
    if (e.type === 'symlink') {
      if (e.linkTarget === undefined) return `The update archive has an unreadable link: ${name}`
      links.set(segments.join('/'), e.linkTarget)
    }
    paths.push({ name, segments })
  }
  for (const { name, segments } of paths) {
    for (let i = 1; i < segments.length; i++) {
      if (links.has(segments.slice(0, i).join('/')))
        return `The update archive has a path through a link: ${name}`
    }
  }
  for (const [where, target] of links) {
    const resolved = resolveLink(where.split('/').slice(0, -1), target, links, 0)
    if (!resolved || resolved[0] !== BUNDLE)
      return `The update archive has a link that points outside ${BUNDLE}: ${where}`
  }
  return null
}

/** Read the zip's central directory and vet it; throws with the reason (no local path). */
export async function vetReleaseZip(
  file: string,
  list: (file: string) => Promise<ZipListing[]> = listZipEntries
): Promise<void> {
  let entries: ZipListing[]
  try {
    entries = await list(file)
  } catch (err) {
    const why = err instanceof ArchiveError ? err.message : 'it could not be read'
    throw new Error(`The update archive is not a zip ClaudeUI can check: ${why}`, { cause: err })
  }
  const refused = vetReleaseEntries(entries)
  if (refused) throw new Error(refused)
}
