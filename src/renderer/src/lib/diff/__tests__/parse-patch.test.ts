import { describe, it, expect } from 'vitest'
import { parsePatch, isPureAdd, isPureDel } from '../parse-patch'

const SIMPLE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 import { bar } from './bar'

-const x = 1
+const x = 2
+const y = 3

 export { x }
`

const MULTI_HUNK_PATCH = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2_modified
 line3
@@ -10,3 +10,4 @@
 line10
 line11
+line11.5
 line12
`

const NEW_FILE_PATCH = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+export const a = 1
+export const b = 2
+export const c = 3
`

const DELETED_FILE_PATCH = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abcdefg..0000000
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const a = 1
-export const b = 2
-export const c = 3
`

describe('parsePatch', () => {
  it('parses a simple single-hunk patch', () => {
    const result = parsePatch(SIMPLE_PATCH)

    expect(result.oldFileName).toBe('src/foo.ts')
    expect(result.newFileName).toBe('src/foo.ts')
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldCount).toBe(5)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newCount).toBe(6)

    // Check line types
    const types = hunk.lines.map((l) => l.type)
    expect(types).toEqual(['context', 'context', 'del', 'add', 'add', 'context', 'context'])
  })

  it('parses line numbers correctly', () => {
    const result = parsePatch(SIMPLE_PATCH)
    const lines = result.hunks[0].lines

    // First context line: old=1, new=1
    expect(lines[0].oldLineNumber).toBe(1)
    expect(lines[0].newLineNumber).toBe(1)

    // Second context line: old=2, new=2
    expect(lines[1].oldLineNumber).toBe(2)
    expect(lines[1].newLineNumber).toBe(2)

    // Del line: old=3, new=undefined
    expect(lines[2].oldLineNumber).toBe(3)
    expect(lines[2].newLineNumber).toBeUndefined()

    // First add: old=undefined, new=3
    expect(lines[3].oldLineNumber).toBeUndefined()
    expect(lines[3].newLineNumber).toBe(3)

    // Second add: old=undefined, new=4
    expect(lines[4].oldLineNumber).toBeUndefined()
    expect(lines[4].newLineNumber).toBe(4)

    // Context after adds: old=4, new=5
    expect(lines[5].oldLineNumber).toBe(4)
    expect(lines[5].newLineNumber).toBe(5)
  })

  it('parses line content without +/- prefix', () => {
    const result = parsePatch(SIMPLE_PATCH)
    const lines = result.hunks[0].lines

    expect(lines[0].content).toBe("import { bar } from './bar'")
    expect(lines[2].content).toBe('const x = 1')
    expect(lines[3].content).toBe('const x = 2')
    expect(lines[4].content).toBe('const y = 3')
  })

  it('parses multi-hunk patches', () => {
    const result = parsePatch(MULTI_HUNK_PATCH)

    expect(result.hunks).toHaveLength(2)

    expect(result.hunks[0].oldStart).toBe(1)
    expect(result.hunks[0].oldCount).toBe(3)
    expect(result.hunks[0].newStart).toBe(1)
    expect(result.hunks[0].newCount).toBe(3)

    expect(result.hunks[1].oldStart).toBe(10)
    expect(result.hunks[1].oldCount).toBe(3)
    expect(result.hunks[1].newStart).toBe(10)
    expect(result.hunks[1].newCount).toBe(4)

    // Second hunk should have an add line
    const addLines = result.hunks[1].lines.filter((l) => l.type === 'add')
    expect(addLines).toHaveLength(1)
    expect(addLines[0].content).toBe('line11.5')
  })

  it('parses new file patches', () => {
    const result = parsePatch(NEW_FILE_PATCH)

    expect(result.oldFileName).toBe('/dev/null')
    expect(result.newFileName).toBe('new.ts')
    expect(result.hunks).toHaveLength(1)

    // All lines should be adds
    const allAdds = result.hunks[0].lines.every((l) => l.type === 'add')
    expect(allAdds).toBe(true)
    expect(result.hunks[0].lines).toHaveLength(3)
  })

  it('parses deleted file patches', () => {
    const result = parsePatch(DELETED_FILE_PATCH)

    expect(result.oldFileName).toBe('old.ts')
    expect(result.newFileName).toBe('/dev/null')
    expect(result.hunks).toHaveLength(1)

    // All lines should be dels
    const allDels = result.hunks[0].lines.every((l) => l.type === 'del')
    expect(allDels).toBe(true)
    expect(result.hunks[0].lines).toHaveLength(3)
  })

  it('handles patches with no trailing newline marker', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line1
-line2
\\ No newline at end of file
+line2_new
\\ No newline at end of file
`
    const result = parsePatch(patch)
    expect(result.hunks[0].lines).toHaveLength(3)
    // The "no newline" markers should be skipped
    expect(result.hunks[0].lines.map((l) => l.type)).toEqual(['context', 'del', 'add'])
  })

  it('handles hunk header without count (implies count=1)', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -5 +5 @@
-old
+new
`
    const result = parsePatch(patch)
    const hunk = result.hunks[0]
    expect(hunk.oldStart).toBe(5)
    expect(hunk.oldCount).toBe(1)
    expect(hunk.newStart).toBe(5)
    expect(hunk.newCount).toBe(1)
  })

  it('preserves empty lines within hunks as context', () => {
    // In real git diffs, empty context lines have a leading space.
    // Bare empty lines (no space prefix) are also treated as context
    // since git may strip trailing whitespace from empty lines.
    const patch = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,5 @@
 line1

-line3
+line3_new

 line5`
    const result = parsePatch(patch)
    const lines = result.hunks[0].lines
    // line1(ctx), empty(ctx), line3(del), line3_new(add), empty(ctx), line5(ctx)
    expect(lines).toHaveLength(6)
    expect(lines[1].type).toBe('context')
    expect(lines[1].content).toBe('')
    expect(lines[4].type).toBe('context')
    expect(lines[4].content).toBe('')
  })
})

describe('isPureAdd', () => {
  it('returns true for new file patches', () => {
    expect(isPureAdd(NEW_FILE_PATCH)).toBe(true)
  })

  it('returns false for modification patches', () => {
    expect(isPureAdd(SIMPLE_PATCH)).toBe(false)
  })

  it('returns false for deleted file patches', () => {
    expect(isPureAdd(DELETED_FILE_PATCH)).toBe(false)
  })

  it('does not false-positive on /dev/null in content', () => {
    const patch = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 const a = '/dev/null'
-const b = 1
+const b = 2
 export {}
`
    expect(isPureAdd(patch)).toBe(false)
  })
})

describe('isPureDel', () => {
  it('returns true for deleted file patches', () => {
    expect(isPureDel(DELETED_FILE_PATCH)).toBe(true)
  })

  it('returns false for modification patches', () => {
    expect(isPureDel(SIMPLE_PATCH)).toBe(false)
  })

  it('returns false for new file patches', () => {
    expect(isPureDel(NEW_FILE_PATCH)).toBe(false)
  })
})
