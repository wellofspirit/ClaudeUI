import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Guard: the desktop and web stylesheets must not drift again.
 *
 * Both clients share ONE stylesheet, `app.css`. The two entry files
 * (`renderer/src/assets/main.css`, `web/main.css`) may only hold the Tailwind
 * import, `@source` lines, the `app.css` import, and platform-specific
 * `html` / `body` / `#root` rules. Any other rule in an entry file renders on
 * one client only (find-in-chat highlights, agent colours and the like went
 * missing on web that way).
 */

const ASSETS = resolve(__dirname, '..')
const ENTRIES = [
  { name: 'src/renderer/src/assets/main.css', path: resolve(ASSETS, 'main.css') },
  { name: 'src/web/main.css', path: resolve(ASSETS, '../../../web/main.css') }
]
const ALLOWED_SELECTORS = new Set(['html', 'body', '#root'])

/** Top-level statements of a stylesheet, comments removed (blocks kept whole). */
function topLevelStatements(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        out.push(src.slice(start, i + 1).trim())
        start = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      out.push(src.slice(start, i + 1).trim())
      start = i + 1
    }
  }
  const rest = src.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

function violations(css: string): string[] {
  const bad: string[] = []
  for (const stmt of topLevelStatements(css)) {
    if (/^@import\s+['"]tailwindcss['"]\s*;$/.test(stmt)) continue
    if (/^@source\s+['"][^'"]+['"]\s*;$/.test(stmt)) continue
    if (/^@import\s+['"][^'"]*\/app\.css['"]\s*;$/.test(stmt)) continue
    const brace = stmt.indexOf('{')
    if (brace > 0 && !stmt.startsWith('@')) {
      const selectors = stmt
        .slice(0, brace)
        .split(',')
        .map((s) => s.trim())
      if (selectors.every((s) => ALLOWED_SELECTORS.has(s))) continue
    }
    bad.push(stmt.split('\n')[0].slice(0, 80))
  }
  return bad
}

describe('stylesheet entry files', () => {
  it.each(ENTRIES)('$name imports the shared app.css', ({ path }) => {
    const css = readFileSync(path, 'utf8')
    expect(css).toMatch(/^@import\s+['"][^'"]*\/?app\.css['"]\s*;/m)
  })

  it.each(ENTRIES)('$name holds only platform html/body/#root rules', ({ name, path }) => {
    const bad = violations(readFileSync(path, 'utf8'))
    expect(
      bad,
      `${name} may only contain the tailwind import, @source lines, the app.css import and ` +
        `html/body/#root rules. Put every other rule in src/renderer/src/assets/app.css so ` +
        `the desktop and web clients share it. Offending: ${bad.join(' | ')}`
    ).toEqual([])
  })

  describe('violation detector', () => {
    it('flags a feature rule, an at-rule block and a mixed selector list', () => {
      expect(violations('.foo{color:red}')).toHaveLength(1)
      expect(violations('@keyframes x{from{opacity:0}to{opacity:1}}')).toHaveLength(1)
      expect(violations('@media (min-width:1px){body{color:red}}')).toHaveLength(1)
      expect(violations('html,.foo{color:red}')).toHaveLength(1)
      expect(violations('::highlight(chat-search){color:red}')).toHaveLength(1)
    })

    it('accepts the allowed statements, comments and quoted braces', () => {
      const css = `@import 'tailwindcss';\n@source "../x";\n@import './app.css';\n/* .foo{} */\nhtml,\n#root{background:red}\nbody{background:url("a{b}.png")}`
      expect(violations(css)).toEqual([])
    })
  })
})
