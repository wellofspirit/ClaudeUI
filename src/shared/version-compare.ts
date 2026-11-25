/**
 * Version order for every layer: the harness store, the app updater, and the
 * renderer's version lists. Pure, no imports.
 */

/**
 * Semver order: numeric major.minor.patch, then a release above its
 * pre-releases, then pre-release tags compared naturally. Build metadata is
 * ignored.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | null] => {
    const [core, ...pre] = v.split('+')[0].split('-')
    return [core.split('.').map(Number), pre.length ? pre.join('-') : null]
  }
  const [ac, ap] = split(a)
  const [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (ac[i] ?? 0) - (bc[i] ?? 0)
    if (d !== 0) return d
  }
  if (ap === bp) return 0
  if (ap === null) return 1
  if (bp === null) return -1
  return ap.localeCompare(bp, 'en', { numeric: true })
}
