import * as fs from 'node:fs'
import * as path from 'node:path'
import { readBuildInfo } from '../core/services/build-info'

/**
 * The build this server is, for the usage hub's per-device facts (ADR-072 §5).
 *
 * A shipped (compiled) server has the stamped `out/build-info.json` beside its
 * executable; a source run has the repository's `package.json`. There is no
 * `app.getVersion()` here, so absent both the answer is `unknown`, which is
 * honest: the alternative is inventing a number.
 */
export function resolveServerVersion(appPath: string, packaged: boolean): string {
  const info = readBuildInfo(appPath, packaged)
  if (info.kind !== 'dev') return info.version
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
