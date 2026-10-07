import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

/**
 * Guard: the desktop and web clients must keep sharing ONE stylesheet.
 *
 * The UI is built once; `app.css` is the only Tailwind root, and the few
 * platform differences (transparent Electron window vs solid browser tab) are
 * keyed on `<html data-shell>` inside it. A second Tailwind root would emit a
 * second CSS file, and rules added to one of them render on one client only
 * (find-in-chat highlights and agent colours went missing on web that way).
 */

const SRC = resolve(__dirname, '../../../..')
const APP_CSS = 'renderer/src/assets/app.css'
const ENTRY_IMPORT = /^import\s+['"]([^'"]+\.css)['"]/gm

/** Every file under `dir` whose name matches `ext`, skipping node_modules. */
function walk(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

describe('single stylesheet', () => {
  it('app.css is the only Tailwind root under src/', () => {
    const roots = walk(SRC, '.css')
      .filter((file) => /@import\s+['"]tailwindcss['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(sep).join('/'))
    expect(roots).toEqual([APP_CSS])
  })

  it.each(['renderer/src/main.tsx', 'web/main.tsx'])(
    '%s imports app.css and no other assets/ stylesheet',
    (entry) => {
      const imports = [...read(entry).matchAll(ENTRY_IMPORT)].map((m) => m[1])
      const assets = imports.filter((spec) => /(^|\/)assets\/[^/]+\.css$/.test(spec))
      expect(assets.map((spec) => spec.split('/').pop())).toEqual(['app.css'])
    }
  )

  it.each([
    { html: 'renderer/index.html', shell: 'desktop', script: '/src/main.tsx' },
    { html: 'renderer/web.html', shell: 'web', script: '../web/main.tsx' }
  ])('$html is the $shell shell and loads its own entry', ({ html, shell, script }) => {
    const source = read(html)
    expect(source).toContain(`<html data-shell="${shell}">`)
    expect(source).toContain(`<script type="module" src="${script}"></script>`)
  })
})
