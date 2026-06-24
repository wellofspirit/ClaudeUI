import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // electron-context-menu v4 is ESM-only; Node's `require(esm)` returns a
    // namespace object so the default-import call site fails. Inline-bundle
    // it so rollup converts the ESM default export into a callable for our
    // CJS main process output.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-context-menu'] })],
    build: {
      rollupOptions: {
        external: ['node-pty', 'ws', 'better-sqlite3']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'plugin-preload': resolve('src/preload/plugin-preload.ts'),
          'log-viewer-preload': resolve('src/preload/log-viewer-preload.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'log-viewer': resolve('src/renderer/log-viewer.html')
        }
      }
    }
  }
})
