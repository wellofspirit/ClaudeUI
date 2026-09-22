/**
 * splitHeredocs / detectOutputFormat — the "structure or nothing" guards.
 *
 * Every test here is really the same assertion twice over: a shape we can name
 * gets named, and anything else declines. Colour that implies structure the text
 * does not have is worse than no colour, so the declining cases are the point.
 */

import { describe, it, expect } from 'vitest'
import {
  splitHeredocs,
  commandLangLabel,
  detectOutputFormat,
  singleFileRead,
  splitGrepLine,
  OUTPUT_HIGHLIGHT_MAX_CHARS
} from '../shell-highlight'

describe('splitHeredocs', () => {
  it('leaves an ordinary command as one bash segment', () => {
    expect(splitHeredocs('rg -n "needle" src | head -20')).toEqual([
      { text: 'rg -n "needle" src | head -20', lang: 'bash' }
    ])
  })

  it('gives a python heredoc body the python language', () => {
    const cmd = "python - <<'PY'\nimport os\nprint(os.getcwd())\nPY"
    expect(splitHeredocs(cmd)).toEqual([
      { text: "python - <<'PY'\n", lang: 'bash' },
      { text: 'import os\nprint(os.getcwd())\n', lang: 'python' },
      { text: 'PY', lang: 'bash' }
    ])
  })

  it('resolves the interpreter through a pipeline rather than taking the first word', () => {
    const cmd = "cat in.txt | python3 - <<'PY'\nx = 1\nPY"
    expect(splitHeredocs(cmd)[1]).toEqual({ text: 'x = 1\n', lang: 'python' })
  })

  it('honours a language-shaped tag when the interpreter is unknown', () => {
    const cmd = "psql mydb <<'SQL'\nSELECT 1;\nSQL"
    expect(splitHeredocs(cmd)[1].lang).toBe('sql')
  })

  it('leaves a data heredoc (cat/tee) alone', () => {
    const cmd = "cat > notes.txt <<'EOF'\njust words\nEOF"
    expect(splitHeredocs(cmd)).toEqual([{ text: cmd, lang: 'bash' }])
  })

  it('treats an unterminated heredoc as a body that runs to the end', () => {
    const cmd = "python - <<'PY'\nimport os"
    expect(splitHeredocs(cmd)).toEqual([
      { text: "python - <<'PY'\n", lang: 'bash' },
      { text: 'import os', lang: 'python' }
    ])
  })

  it('does not split an opener that has no body yet (mid-stream)', () => {
    expect(splitHeredocs("python - <<'PY'")).toEqual([{ text: "python - <<'PY'", lang: 'bash' }])
  })

  it('labels the mix for the header chip, and nothing for plain bash', () => {
    expect(commandLangLabel(splitHeredocs("python - <<'PY'\nx=1\nPY"))).toBe('sh + py')
    expect(commandLangLabel(splitHeredocs('ls -la'))).toBeNull()
  })
})

describe('detectOutputFormat — grep', () => {
  it('names the language from the paths in a path:line: gutter', () => {
    const text = 'src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2\nsrc/b.ts:3:export {}'
    expect(detectOutputFormat(text)).toEqual({ kind: 'grep', lang: 'typescript' })
  })

  it('handles a context gutter (path-line-) as well as a match gutter', () => {
    const text = 'a.py-10-import os\na.py:11:print(1)\na.py-12-pass'
    expect(detectOutputFormat(text)).toEqual({ kind: 'grep', lang: 'python' })
  })

  it('takes the language from the command when the gutter carries no path', () => {
    const text = '107-        before: 1\n108-        after: 2\n109-        files:'
    expect(detectOutputFormat(text, 'grep -n "x" -A 14 src/a.tsx')).toEqual({
      kind: 'grep',
      lang: 'tsx'
    })
  })

  it('declines when too few lines have the shape', () => {
    const text = 'a.ts:1:hit\nsome prose here\nmore prose\nand more prose'
    expect(detectOutputFormat(text)).toEqual({ kind: 'plain' })
  })
})

describe('detectOutputFormat — diff, json, file', () => {
  it('detects a git diff by its header', () => {
    expect(detectOutputFormat('diff --git a/x b/x\nindex 1..2\n+added')).toEqual({ kind: 'diff' })
  })

  it('detects a bare hunk header', () => {
    expect(detectOutputFormat('@@ -1,3 +1,4 @@\n context\n+added')).toEqual({ kind: 'diff' })
  })

  it('detects JSON only when it actually parses', () => {
    expect(detectOutputFormat('{"a": 1}')).toEqual({ kind: 'json' })
    expect(detectOutputFormat('{this is not json')).toEqual({ kind: 'plain' })
  })

  it('reads a single-file cat as that file language', () => {
    expect(detectOutputFormat('const x = 1\nexport {}', 'cat src/a.ts')).toEqual({
      kind: 'file',
      lang: 'typescript'
    })
  })

  it('declines a piped read, whose output belongs to the pipe rather than the file', () => {
    expect(detectOutputFormat('const x = 1', 'cat src/a.ts | grep x')).toEqual({ kind: 'plain' })
  })
})

describe('detectOutputFormat — refusals', () => {
  it('never re-highlights output that carries ANSI', () => {
    const coloured = '\u001b[32msrc/a.ts:1:hit\u001b[0m\nsrc/a.ts:2:hit\nsrc/a.ts:3:hit'
    expect(detectOutputFormat(coloured)).toEqual({ kind: 'plain' })
  })

  it('falls back to plain above the size cap', () => {
    const huge = 'a.ts:1:x\n'.repeat(Math.ceil(OUTPUT_HIGHLIGHT_MAX_CHARS / 9) + 10)
    expect(huge.length).toBeGreaterThan(OUTPUT_HIGHLIGHT_MAX_CHARS)
    expect(detectOutputFormat(huge)).toEqual({ kind: 'plain' })
  })

  it('says plain for empty output', () => {
    expect(detectOutputFormat('')).toEqual({ kind: 'plain' })
    expect(detectOutputFormat('\n\n')).toEqual({ kind: 'plain' })
  })
})

describe('singleFileRead', () => {
  it('accepts one plain read of one known file type', () => {
    expect(singleFileRead('cat src/a.ts')).toBe('src/a.ts')
    expect(singleFileRead('head -40 src/a.py')).toBe('src/a.py')
    expect(singleFileRead("sed -n '1,60p' src/a.tsx")).toBe('src/a.tsx')
  })

  it('refuses anything with a pipe, a redirect or a second path', () => {
    expect(singleFileRead('cat a.ts | head')).toBeNull()
    expect(singleFileRead('cat a.ts > b.ts')).toBeNull()
    expect(singleFileRead('cat a.ts b.ts')).toBeNull()
  })

  it('refuses a file whose type it cannot name', () => {
    expect(singleFileRead('cat LICENSE')).toBeNull()
  })
})

describe('splitGrepLine', () => {
  it('splits a path gutter from its content', () => {
    expect(splitGrepLine('src/a.ts:12:const x = 1')).toEqual({
      gutter: 'src/a.ts:12:',
      content: 'const x = 1'
    })
  })

  it('splits a bare line-number gutter', () => {
    expect(splitGrepLine('107-        before: 1')).toEqual({
      gutter: '107-',
      content: '        before: 1'
    })
  })

  it('returns null for a line with no gutter', () => {
    expect(splitGrepLine('--')).toBeNull()
    expect(splitGrepLine('Found 4 files')).toBeNull()
  })
})
