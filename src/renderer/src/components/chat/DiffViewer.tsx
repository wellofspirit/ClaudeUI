import { useMemo } from 'react'
import { DiffView, DiffModeEnum } from '@git-diff-view/react'
import { DiffFile } from '@git-diff-view/core'
import { createPatch } from 'diff'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import '@git-diff-view/react/styles/diff-view.css'

interface Props {
  oldStr: string
  newStr: string
  fileName?: string
  ignoreWhitespace?: boolean
  /** Extra classes on the outer wrapper (e.g. "h-full" to fill a flex parent) */
  className?: string
}

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

export function DiffViewer({ oldStr, newStr, fileName, ignoreWhitespace, className }: Props): React.JSX.Element {
  const diffViewSplit = useSessionStore((s) => s.settings.diffViewSplit)
  const diffWrapLines = useSessionStore((s) => s.settings.diffWrapLines)
  const theme = useSessionStore((s) => s.settings.theme)

  // Pure addition (new file) or pure deletion — hide the empty line-number column
  const isPureAdd = oldStr === ''
  const isPureDel = newStr === ''

  const diffFile = useMemo(() => {
    const name = fileName || 'file'
    // When ignoring whitespace, generate the patch from normalised content
    // so that whitespace-only changes don't appear as diffs, but still feed
    // the original content to the viewer for accurate display.
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
  }, [oldStr, newStr, fileName, ignoreWhitespace])

  return (
    <div className={`diff-scroll-container rounded-md border border-border overflow-auto font-mono [&_.diff-tailwindcss-wrapper]:!text-[11px] [&_.leading-\\[1\\.6\\]]:!leading-[1.3] [&_.min-h-\\[28px\\]]:!min-h-0 [&_.py-\\[6px\\]]:!py-[2px]${isPureAdd ? ' diff-pure-add' : ''}${isPureDel ? ' diff-pure-del' : ''}${className ? ` ${className}` : ''}`} style={{ textShadow: '0 1px rgba(0, 0, 0, 0.3)' }}>
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
