import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    // After the lazy splits (mermaid core, xterm, RemoteAccessModal) the eager App
    // chunk sits at ~1.18 MB min and the only >500 kB chunks left are deliberate
    // (App + mermaid's own lazy internals). 1200 keeps the warning silent for the
    // current shape but trips as soon as the eager chunk regresses past it.
    chunkSizeWarningLimit: 1200
  }
})
