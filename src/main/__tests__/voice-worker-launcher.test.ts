/**
 * @vitest-environment node
 *
 * How the desktop launches the voice worker (ADR-101 §4) and that the build
 * really produces the entry it names.
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { desktopVoiceWorkerLauncher, VOICE_WORKER_ENTRY } from '../voice-worker-launcher'

const ROOT = path.join(__dirname, '..', '..', '..')
const WORKER_ARGS = ['--addon', 'C:/store/sherpa-onnx-node', '--model', 'C:/store/model']

describe('desktopVoiceWorkerLauncher', () => {
  it('runs the app’s own binary as Node on out/main/voice-worker.js', () => {
    const launch = desktopVoiceWorkerLauncher(
      'D:/repo',
      'D:/repo/node_modules/electron/electron.exe'
    )(WORKER_ARGS)

    expect(launch.command).toBe('D:/repo/node_modules/electron/electron.exe')
    expect(launch.args).toEqual([
      path.join('D:/repo', 'out', 'main', 'voice-worker.js'),
      ...WORKER_ARGS
    ])
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('resolves the script inside app.asar when packaged — Electron’s Node mode reads asars', () => {
    const appPath = path.join('C:', 'Program Files', 'ClaudeUI', 'resources', 'app.asar')
    const { args } = desktopVoiceWorkerLauncher(appPath, 'C:/ClaudeUI/ClaudeUI.exe')(WORKER_ARGS)

    expect(args[0]).toBe(path.join(appPath, 'out', 'main', 'voice-worker.js'))
    // The speech pack is read from the user's store, never from the asar.
    expect(args.slice(1)).toEqual(WORKER_ARGS)
  })

  it('names the entry the main build emits beside index.js', () => {
    expect(VOICE_WORKER_ENTRY).toBe(path.join('out', 'main', 'voice-worker.js'))
  })
})

describe('the voice-worker main entry', () => {
  it('is a second electron-vite main input, next to index', () => {
    const config = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/'voice-worker':\s*resolve\('src\/main\/voice-worker\.ts'\)/)
    expect(config).toMatch(/index:\s*resolve\('src\/main\/index\.ts'\)/)
  })

  it('imports nothing from Electron — it runs as plain Node (ELECTRON_RUN_AS_NODE)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'voice-worker.ts'), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])

    expect(imports).toEqual(['../core/voice/worker/main'])
  })
})
