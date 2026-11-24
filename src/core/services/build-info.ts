import * as fs from 'node:fs'
import * as path from 'node:path'
import { BUILD_INFO_RELATIVE_PATH, parseBuildInfo } from '../../shared/build-info'
import type { BuildInfo, DevBuildInfo } from '../../shared/build-info'

/**
 * The identity of the running build: `<appPath>/out/build-info.json` when the
 * app is packaged, else `{ kind: 'dev' }`. An unpackaged run is dev whatever
 * the file says: a stale file from an earlier build must not make
 * `bun run dev` look like a local build. Never throws.
 */
export function readBuildInfo(appPath: string, packaged: boolean): BuildInfo | DevBuildInfo {
  if (!packaged) return { kind: 'dev' }
  try {
    const raw = fs.readFileSync(path.join(appPath, ...BUILD_INFO_RELATIVE_PATH.split('/')), 'utf8')
    return parseBuildInfo(JSON.parse(raw)) ?? { kind: 'dev' }
  } catch {
    return { kind: 'dev' }
  }
}
