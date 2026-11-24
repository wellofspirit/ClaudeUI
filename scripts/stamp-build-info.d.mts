import type { BuildInfo } from '../src/shared/build-info'

export function buildInfoFor(opts: {
  env?: Record<string, string | undefined>
  git?: (args: string[]) => string | null
  now?: Date
  version: string
}): BuildInfo
