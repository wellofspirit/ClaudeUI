/**
 * How `claudeui-server` relaunches itself as the voice worker (ADR-101 §4).
 */

import { describe, expect, it } from 'vitest'
import { isCompiledBunEntry, serverVoiceWorkerLauncher } from '../voice-worker-launcher'

const WORKER_ARGS = ['--addon', '/store/sherpa', '--model', '/store/model']

describe('isCompiledBunEntry', () => {
  it('recognises the virtual entry paths of a compiled bun executable', () => {
    expect(isCompiledBunEntry('/$bunfs/root/claudeui-server')).toBe(true)
    expect(isCompiledBunEntry(String.raw`B:\~BUN\root\claudeui-server.exe`)).toBe(true)
    expect(isCompiledBunEntry('B:/~BUN/root/claudeui-server.exe')).toBe(true)
  })

  it('does not take a real script path for one', () => {
    expect(isCompiledBunEntry('/srv/claudeui/src/server/main.ts')).toBe(false)
    expect(isCompiledBunEntry(String.raw`D:\repo\dist\server\claudeui-server.js`)).toBe(false)
    expect(isCompiledBunEntry(undefined)).toBe(false)
  })
})

describe('serverVoiceWorkerLauncher', () => {
  it('compiled: the executable alone, then the subcommand', () => {
    const launch = serverVoiceWorkerLauncher(
      '/opt/claudeui-server',
      '/$bunfs/root/claudeui-server'
    )(WORKER_ARGS)

    expect(launch.command).toBe('/opt/claudeui-server')
    expect(launch.args).toEqual(['voice-worker', ...WORKER_ARGS])
  })

  it('from source or the bundle: the runtime, the script it was started with, then the subcommand', () => {
    const launch = serverVoiceWorkerLauncher(
      '/usr/bin/bun',
      '/srv/claudeui/src/server/main.ts'
    )(WORKER_ARGS)

    expect(launch.command).toBe('/usr/bin/bun')
    expect(launch.args).toEqual([
      '/srv/claudeui/src/server/main.ts',
      'voice-worker',
      ...WORKER_ARGS
    ])
  })

  it('adds no environment: the worker needs nothing but its token', () => {
    expect(serverVoiceWorkerLauncher('/x', '/y.ts')(WORKER_ARGS).env).toBeUndefined()
  })
})
