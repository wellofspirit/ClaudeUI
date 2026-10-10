import { join, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { compressDir } from './scripts/compress-web-assets.mjs'

// RemoteServer.serveStatic hands the `.br`/`.gz` siblings this writes to phones.
// Doing it in the build itself, not a package.json script, covers every path that
// builds the UI (bun run build, a bare electron-vite build in CI, packaging).
function compressAssets(): Plugin {
  let outDir = ''
  return {
    name: 'compress-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await compressDir(join(outDir, 'assets'), { quiet: true })
    }
  }
}

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
    plugins: [react(), tailwindcss(), compressAssets()],
    build: {
      // electron-vite defaults the renderer to `minify: false` (fine for a file://
      // load from the asar), but RemoteServer ships these same chunks to phones:
      // unminified, App is ~3.7 MB (545 kB brotli) against ~1.8 MB (389 kB) minified.
      minify: 'esbuild',
      // Linked maps, so DevTools on desktop and web shows original sources; DevTools
      // only fetches a map while it is open. Error.stack stays minified (Chromium
      // never applies maps to it): scripts/decode-stack.mjs decodes log stacks.
      sourcemap: true,
      // The eager App chunk is shared by the desktop and web entries. After the
      // lazy splits (mermaid core, xterm, RemoteAccessModal) it sits at ~1.76 MB
      // min and the only other >500 kB chunks are mermaid's own lazy internals
      // (core, cynefin). 1800 keeps the warning silent for the current shape but
      // trips as soon as the eager chunk regresses past it. (The old 1200 predated
      // the quiet build's `--logLevel warn`, which hid that it was already exceeded.)
      chunkSizeWarningLimit: 1800,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'log-viewer': resolve('src/renderer/log-viewer.html'),
          web: resolve('src/renderer/web.html')
        }
      }
    }
  }
})
