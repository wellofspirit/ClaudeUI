/**
 * Builds the app's REAL stylesheet once per `layout` run and hands it to the
 * tests through vitest's `provide`/`inject` channel.
 *
 * It has to live in a global setup rather than in the test: vite pulls in
 * esbuild, which asserts at import time that `new TextEncoder().encode('')`
 * produces a same-realm `Uint8Array` — false under jsdom, so importing vite
 * from a jsdom test file throws "your JavaScript environment is broken". A
 * global setup runs in vitest's own Node process, where it is true.
 *
 * The CSS comes from `src/renderer/src/assets/main.css` through the same
 * `@tailwindcss/vite` plugin the app builds with, so the classes the
 * measurement resolves are the ones the app ships. A class no one has used yet
 * simply is not in the sheet, which is the property that keeps the measurement
 * honest.
 */
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const CSS_ENTRY = resolve(REPO_ROOT, 'src/renderer/src/assets/main.css')

declare module 'vitest' {
  interface ProvidedContext {
    appCss: string
  }
}

export async function setup(project: TestProject): Promise<void> {
  const result = await build({
    root: REPO_ROOT,
    configFile: false,
    logLevel: 'error',
    plugins: [tailwindcss()],
    build: { write: false, cssMinify: false, rollupOptions: { input: CSS_ENTRY } }
  })
  const bundles = Array.isArray(result) ? result : [result]
  for (const bundle of bundles) {
    if (!('output' in bundle)) continue
    for (const output of bundle.output)
      if (output.type === 'asset' && output.fileName.endsWith('.css')) {
        project.provide('appCss', String(output.source))
        return
      }
  }
  throw new Error(`vite produced no CSS for ${CSS_ENTRY}`)
}
