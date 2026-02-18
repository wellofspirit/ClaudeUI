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
  const diffViewSplit = useSessionStore((s) => s.settings.diffViewSplit)
  const diffWrapLines = useSessionStore((s) => s.settings.diffWrapLines)
  const theme = useSessionStore((s) => s.settings.theme)

  // Detect pure add/del for CSS class.
  // Only check the diff header (before first @@), not the content — otherwise
  // a file whose source code contains '/dev/null' as a string literal would
  // false-positive (e.g. DiffViewer.tsx itself).
  const patchHeader = props.patch != null ? props.patch.slice(0, props.patch.indexOf('\n@@')) : ''
  const isPureAdd = props.patch != null
    ? patchHeader.includes('--- /dev/null')
    : props.oldStr === ''
  const isPureDel = props.patch != null
    ? patchHeader.includes('+++ /dev/null')
    : props.newStr === ''

  const diffFile = useMemo(() => {
    const name = fileName || 'file'

    if (props.patch != null) {
      // Fast path: pre-computed patch from git diff — no JS diffing needed.
      // When oldContent/newContent are provided (background-loaded), pass them
      // so the library can expand collapsed hunks to show full file context.
      const instance = DiffFile.createInstance({
        oldFile: { fileName: name, content: props.oldContent ?? null },
        newFile: { fileName: name, content: props.newContent ?? null },
        hunks: [props.patch],
      })
      instance.init()
      instance.buildUnifiedDiffLines()
      instance.buildSplitDiffLines()
      return instance
    }

    // Slow path: compute patch from old/new strings (ToolCallBlock inline diffs)
    const { oldStr, newStr, ignoreWhitespace } = props
    const patchOld = ignoreWhitespace ? normalizeWs(oldStr) : oldStr
    const patchNew = ignoreWhitespace ? normalizeWs(newStr) : newStr
    const patch = createPatch(name, patchOld, patchNew, '', '', { context: 3 })
    const instance = DiffFile.createInstance({
      oldFile: { fileName: name, content: ignoreWhitespace ? patchOld : oldStr },
      newFile: { fileName: name, content: ignoreWhitespace ? patchNew : newStr },
      hunks: [patch],
    })
    instance.init()
    instance.buildUnifiedDiffLines()
    instance.buildSplitDiffLines()
    return instance
  }, [props.patch, props.oldContent, props.newContent, props.oldStr, props.newStr, fileName, props.ignoreWhitespace])

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
