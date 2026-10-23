/** @vitest-environment node */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../../electron.vite.config'

describe('Electron build configuration', () => {
  it('bundles the ESM context menu while keeping native main dependencies external', () => {
    expect(config.main?.build?.externalizeDeps).toEqual({ exclude: ['electron-context-menu'] })
    expect(config.main?.build?.rolldownOptions?.external).toEqual([
      'node-pty',
      'ws',
      'better-sqlite3'
    ])
  })

  it('keeps preload dependencies bundled for the sandbox', () => {
    expect(config.preload?.build?.externalizeDeps).toBe(false)
  })

  it('preserves the two main, three preload and three HTML entry points', () => {
    expect(config.main?.build?.rolldownOptions?.input).toEqual({
      index: resolve('src/main/index.ts'),
      'voice-worker': resolve('src/main/voice-worker.ts')
    })
    expect(config.preload?.build?.rolldownOptions?.input).toEqual({
      index: resolve('src/preload/index.ts'),
      'plugin-preload': resolve('src/preload/plugin-preload.ts'),
      'log-viewer-preload': resolve('src/preload/log-viewer-preload.ts')
    })
    expect(config.renderer?.build?.rolldownOptions?.input).toEqual({
      index: resolve('src/renderer/index.html'),
      'log-viewer': resolve('src/renderer/log-viewer.html'),
      web: resolve('src/renderer/web.html')
    })
  })

  it('uses Oxc without dropping linked sourcemaps or raising the chunk budget', () => {
    expect(config.renderer?.build?.minify).toBe('oxc')
    expect(config.renderer?.build?.sourcemap).toBe(true)
    expect(config.renderer?.build?.chunkSizeWarningLimit).toBe(1800)
    expect(config.renderer?.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'compress-assets', apply: 'build' })])
    )
  })
})
