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
}

function diffTheme(theme: ThemeId): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark'
}

export function DiffViewer({ oldStr, newStr, fileName }: Props): React.JSX.Element {
  const diffViewSplit = useSessionStore((s) => s.settings.diffViewSplit)
  const theme = useSessionStore((s) => s.settings.theme)

  const diffFile = useMemo(() => {
    const name = fileName || 'file'
    const patch = createPatch(name, oldStr, newStr, '', '', { context: 3 })
    const instance = DiffFile.createInstance({
      oldFile: { fileName: name, content: oldStr },
      newFile: { fileName: name, content: newStr },
      hunks: [patch],
    })
    instance.init()
    instance.buildUnifiedDiffLines()
    instance.buildSplitDiffLines()
    return instance
  }, [oldStr, newStr, fileName])

  return (
    <div className="rounded-md border border-border overflow-hidden font-mono [&_.diff-tailwindcss-wrapper]:!text-[11px] [&_.leading-\[1\.6\]]:!leading-[1.3] [&_.min-h-\[28px\]]:!min-h-0 [&_.py-\[6px\]]:!py-[2px]" style={{ textShadow: '0 1px rgba(0, 0, 0, 0.3)' }}>
      <DiffView
        diffFile={diffFile}
        diffViewMode={diffViewSplit ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewWrap={true}
        diffViewTheme={diffTheme(theme)}
        diffViewFontSize={11}
        diffViewHighlight={true}
      />
    </div>
  )
}
