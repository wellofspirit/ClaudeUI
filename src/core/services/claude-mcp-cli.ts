/**
 * McpDialog's add/remove through Claude Code's own writer:
 *
 *   <claude> mcp add-json -s <scope> -- <name> <json>
 *   <claude> mcp remove   -s <scope> -- <name>
 *
 * cli.js knows where each scope lives (`~/.claude.json`, the project's
 * `.mcp.json`, `~/.claude.json` `projects[<git root>]`), takes its own lock on
 * the global file and validates the entry, so a write here cannot race a live
 * cli.js process the way a host-side read-modify-write would
 * (`.work/mcp-catalog/research/cc-mcp-loading.md` §8). The cwd decides the
 * project/local target, so it must be the session's cwd.
 *
 * The JSON can hold secrets (headers, env): it travels as one argv element, no
 * shell, and is never logged.
 */

import { spawn } from 'node:child_process'
import type { HarnessLaunch } from '../../shared/harness-types'
import type { McpCliResult, McpServerConfig } from '../../shared/types'
import { withLaunch } from '../harness/launch'
import { locateClaudeLaunch } from '../sdk/locate'
import { logger } from './logger'
import { killProcessTree } from './process-tree'

export type NativeMcpScope = 'user' | 'project' | 'local'

export type { McpCliResult }

export interface McpCliDeps {
  launch?: HarnessLaunch
  env?: NodeJS.ProcessEnv
  spawnFn?: typeof spawn
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const OUTPUT_CAP = 8 * 1024
const ERROR_MAX = 600

export function addJsonArgs(
  scope: NativeMcpScope,
  name: string,
  config: McpServerConfig
): string[] {
  return ['mcp', 'add-json', '-s', scope, '--', name, JSON.stringify(config)]
}

export function removeArgs(scope: NativeMcpScope, name: string): string[] {
  return ['mcp', 'remove', '-s', scope, '--', name]
}

function cliEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.NODE_OPTIONS
  env.DISABLE_AUTOUPDATER = '1'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

function runMcpCli(
  args: string[],
  cwd: string | undefined,
  what: string,
  deps: McpCliDeps
): Promise<McpCliResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnFn = deps.spawnFn ?? spawn
  return new Promise<McpCliResult>((resolve) => {
    let settled = false
    let output = ''
    let timedOut = false
    const finish = (result: McpCliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child) killProcessTree(child)
      } catch {
        // already gone
      }
      finish({ error: `claude ${what} did not finish within ${timeoutMs / 1000} s` })
    }, timeoutMs)

    let child: ReturnType<typeof spawn> | undefined
    try {
      const composed = withLaunch(
        deps.launch ?? locateClaudeLaunch(),
        args,
        cliEnv(deps.env ?? process.env)
      )
      child = spawnFn(composed.command, composed.args, {
        cwd,
        env: composed.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      finish({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    const collect = (chunk: Buffer): void => {
      if (output.length < OUTPUT_CAP) output += chunk.toString('utf-8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err: Error) => finish({ error: err.message }))
    child.on('close', (code: number | null) => {
      if (timedOut) return
      if (code === 0) {
        logger.debug('ClaudeMcpCli', `${what} ok`)
        finish({})
        return
      }
      logger.warn('ClaudeMcpCli', `${what} exited with code ${code}`)
      const text = output.trim().slice(0, ERROR_MAX)
      finish({ error: text || `claude ${what} exited with code ${code}` })
    })
  })
}

export function addMcpServerNative(
  scope: NativeMcpScope,
  name: string,
  config: McpServerConfig,
  cwd: string | undefined,
  deps: McpCliDeps = {}
): Promise<McpCliResult> {
  return runMcpCli(addJsonArgs(scope, name, config), cwd, `mcp add-json (${scope})`, deps)
}

export function removeMcpServerNative(
  scope: NativeMcpScope,
  name: string,
  cwd: string | undefined,
  deps: McpCliDeps = {}
): Promise<McpCliResult> {
  return runMcpCli(removeArgs(scope, name), cwd, `mcp remove (${scope})`, deps)
}
