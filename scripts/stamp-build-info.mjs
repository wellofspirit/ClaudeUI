#!/usr/bin/env bun
/**
 * Writes `out/build-info.json`, the identity of this build
 * (`src/shared/build-info.ts` is the schema and the reader).
 *
 *   bun scripts/stamp-build-info.mjs [--out <file>] [--quiet]
 *
 * `release` only when CLAUDEUI_BUILD_KIND=release (the release workflows set it,
 * with CLAUDEUI_RELEASE_CHANNEL=stable|pre-release); anything else is `local`.
 * Git failures (no git, a shallow clone without tags) leave the git fields null
 * and never fail the build. Runs under bun because it imports the shared TS.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_INFO_RELATIVE_PATH, parseGitDescribe } from '../src/shared/build-info.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  try {
    return (
      execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null
    )
  } catch {
    return null
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, git?: (args: string[]) => string | null, now?: Date,
 *           version: string }} opts
 */
export function buildInfoFor({ env = process.env, git: run = git, now = new Date(), version }) {
  const release = env.CLAUDEUI_BUILD_KIND === 'release'
  let channel
  if (release) {
    channel = env.CLAUDEUI_RELEASE_CHANNEL
    if (channel !== 'stable' && channel !== 'pre-release')
      throw new Error(
        `a release build needs CLAUDEUI_RELEASE_CHANNEL=stable|pre-release (got "${channel ?? ''}")`
      )
  }
  const describe = run(['describe', '--tags', '--long', '--match', 'v*', '--dirty'])
  const parsed = describe ? parseGitDescribe(describe) : null
  const commit = run(['rev-parse', 'HEAD']) ?? (release ? (env.GITHUB_SHA ?? null) : null)
  const info = {
    schema: 1,
    kind: release ? 'release' : 'local',
    version,
    ...(release ? { channel } : {}),
    git: {
      describe: parsed ? describe : null,
      baseTag: parsed?.baseTag ?? null,
      ahead: parsed?.ahead ?? null,
      commit,
      dirty: parsed?.dirty ?? null,
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD'])
    },
    ...(release ? {} : { sourcePath: run(['rev-parse', '--show-toplevel']) ?? ROOT }),
    builtAt: now.toISOString()
  }
  return info
}

function main(argv) {
  let out = path.join(ROOT, BUILD_INFO_RELATIVE_PATH)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--quiet')
      continue // always one line
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const info = buildInfoFor({ version })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
  console.log(`build-info: ${info.kind} ${info.version} ${info.git.describe ?? '(no git tag)'}`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`stamp-build-info: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
