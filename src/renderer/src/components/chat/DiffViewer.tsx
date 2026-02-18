import { useMemo } from 'react'
import { DiffView, DiffModeEnum } from '@git-diff-view/react'
import { DiffFile } from '@git-diff-view/core'
import { createPatch } from 'diff'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import '@git-diff-view/react/styles/diff-view.css'

/** Props when providing old/new strings (ToolCallBlock inline diffs) */
interface ContentProps {
  oldStr: string
  newStr: string
  patch?: undefined
  fileName?: string
  ignoreWhitespace?: boolean
  className?: string
}

/** Props when providing a pre-computed patch string (git panel) */
interface PatchProps {
  patch: string
  /** Full file content for hunk expansion — loaded in background after patch */
  oldContent?: string
  newContent?: string
  oldStr?: undefined
  newStr?: undefined
  fileName?: string
  ignoreWhitespace?: never
  className?: string
}

type Props = ContentProps | PatchProps

function diffTheme(theme: ThemeId): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark'
}

/**
 * Collapse whitespace-only differences so the patch only shows lines with
 * meaningful content changes. We normalise leading/trailing whitespace and
 * collapse runs of internal whitespace to a single space before generating
 * the patch, but we still pass the *original* content to the viewer so
 * the displayed text is accurate.
 */
function normalizeWs(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trimEnd().replace(/\s+/g, ' '))
    .join('\n')
}

export function DiffViewer(props: Props): React.JSX.Element {
  const { fileName, className } = props
  // Pull all union fields into local variables so we can reference them in
  // deps arrays without TS errors on discriminated-union property access.
  const patch = 'patch' in props ? props.patch : undefined
  const oldContent = 'oldContent' in props ? (props as PatchProps).oldContent : undefined
  const newContent = 'newContent' in props ? (props as PatchProps).newContent : undefined
  const oldStr = 'oldStr' in props ? props.oldStr : undefined
  const newStr = 'newStr' in props ? props.newStr : undefined
  const ignoreWhitespace = 'ignoreWhitespace' in props ? (props as ContentProps).ignoreWhitespace : undefined
  const diffViewSplit = useSessionStore((s) => s.settings.diffViewSplit)
  const diffWrapLines = useSessionStore((s) => s.settings.diffWrapLines)
  const theme = useSessionStore((s) => s.settings.theme)

  // Detect pure add/del for CSS class.
  // Only check the diff header (before first @@), not the content — otherwise
  // a file whose source code contains '/dev/null' as a string literal would
  // false-positive (e.g. DiffViewer.tsx itself).
  const patchHeader = patch != null ? patch.slice(0, patch.indexOf('\n@@')) : ''
  const isPureAdd = patch != null
    ? patchHeader.includes('--- /dev/null')
    : oldStr === ''
  const isPureDel = patch != null
    ? patchHeader.includes('+++ /dev/null')
    : newStr === ''

  const diffFile = useMemo(() => {
    const name = fileName || 'file'

    if (patch != null) {
      // Fast path: pre-computed patch from git diff — no JS diffing needed.
      // When oldContent/newContent are provided (background-loaded), pass them
      // so the library can expand collapsed hunks to show full file context.
      const instance = DiffFile.createInstance({
        oldFile: { fileName: name, content: oldContent ?? null },
        newFile: { fileName: name, content: newContent ?? null },
        hunks: [patch],
      })
      instance.init()
      instance.buildUnifiedDiffLines()
      instance.buildSplitDiffLines()
      return instance
    }

    // Slow path: compute patch from old/new strings (ToolCallBlock inline diffs)
    const patchOld = ignoreWhitespace ? normalizeWs(oldStr!) : oldStr!
    const patchNew = ignoreWhitespace ? normalizeWs(newStr!) : newStr!
    const computedPatch = createPatch(name, patchOld, patchNew, '', '', { context: 3 })
    const instance = DiffFile.createInstance({
      oldFile: { fileName: name, content: ignoreWhitespace ? patchOld : oldStr! },
      newFile: { fileName: name, content: ignoreWhitespace ? patchNew : newStr! },
      hunks: [computedPatch],
    })
    instance.init()
    instance.buildUnifiedDiffLines()
    instance.buildSplitDiffLines()
    return instance
  }, [patch, oldContent, newContent, oldStr, newStr, fileName, ignoreWhitespace])

  return (
    <div className={`diff-scroll-container rounded-md border border-border overflow-auto font-mono [&_.diff-tailwindcss-wrapper]:!text-[11px]${isPureAdd ? ' diff-pure-add' : ''}${isPureDel ? ' diff-pure-del' : ''}${className ? ` ${className}` : ''}`} style={{ textShadow: '0 1px rgba(0, 0, 0, 0.3)' }}>
      <DiffView
        diffFile={diffFile}
        diffViewMode={diffViewSplit ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewWrap={diffWrapLines}
        diffViewTheme={diffTheme(theme)}
        diffViewFontSize={11}
        diffViewHighlight={true}
      />
    </div>
  )
}
