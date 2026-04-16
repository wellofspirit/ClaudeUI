import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import type { GitFileStatus } from '../../../../../shared/types'
import {
  type ContextTarget,
  type ContextMenuState,
  buildTree,
  flattenSingleChildDirs,
  filterAndSortFiles,
  isStaged
} from './utils'
import { GitFileTreeView } from './View'

/** Raw screen coordinates — no zoom adjustment needed since we portal to document.body */
function contextMenuPosition(e: React.MouseEvent): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY }
}

export function GitFileTree(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitFileFilter = useActiveSession((s) => s.gitFileFilter)
  const gitSelectedFile = useActiveSession((s) => s.gitSelectedFile)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitSelectedFile = useSessionStore((s) => s.setGitSelectedFile)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<ContextTarget | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const filteredFiles = useMemo(
    () => filterAndSortFiles(gitStatus?.files ?? [], gitFileFilter),
    [gitStatus, gitFileFilter]
  )

  const tree = useMemo(() => flattenSingleChildDirs(buildTree(filteredFiles)), [filteredFiles])

  const handleSelectFile = useCallback((filePath: string) => {
    if (!activeSessionId) return
    setGitSelectedFile(activeSessionId, filePath === gitSelectedFile ? null : filePath)
  }, [activeSessionId, gitSelectedFile, setGitSelectedFile])

  const handleToggleStage = useCallback(async (file: GitFileStatus, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!cwd || !activeSessionId) return
    try {
      if (isStaged(file)) {
        await window.api.gitUnstageFile(cwd, file.path)
      } else {
        await window.api.gitStageFile(cwd, file.path)
      }
      const status = await window.api.gitGetStatus(cwd)
      setGitStatus(activeSessionId, status)
    } catch {
      // Silently ignore
    }
  }, [cwd, activeSessionId, setGitStatus])

  const handleToggleStageDirFiles = useCallback(async (files: GitFileStatus[], stage: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!cwd || !activeSessionId) return
    try {
      for (const file of files) {
        if (stage) {
          await window.api.gitStageFile(cwd, file.path)
        } else {
          await window.api.gitUnstageFile(cwd, file.path)
        }
      }
      const status = await window.api.gitGetStatus(cwd)
      setGitStatus(activeSessionId, status)
    } catch {
      // Silently ignore
    }
  }, [cwd, activeSessionId, setGitStatus])

  const handleFileContextMenu = useCallback((file: GitFileStatus, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ ...contextMenuPosition(e), target: { kind: 'file', file } })
  }, [])

  const handleDirContextMenu = useCallback((files: GitFileStatus[], dirName: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ ...contextMenuPosition(e), target: { kind: 'dir', files, dirName } })
  }, [])

  // Clamp context menu to viewport after render
  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const el = contextMenuRef.current
    const rect = el.getBoundingClientRect()
    let { x, y } = contextMenu
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4
    if (x !== contextMenu.x || y !== contextMenu.y) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [contextMenu])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent): void => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  // Execute discard
  const executeDiscard = useCallback(async (target: ContextTarget) => {
    if (!cwd || !activeSessionId) return
    try {
      const files = target.kind === 'file' ? [target.file] : target.files
      for (const file of files) {
        await window.api.gitDiscardFile(cwd, file.path)
      }
      const status = await window.api.gitGetStatus(cwd)
      setGitStatus(activeSessionId, status)
      if (gitSelectedFile) {
        const discardedPaths = new Set(files.map((f) => f.path))
        if (discardedPaths.has(gitSelectedFile)) {
          setGitSelectedFile(activeSessionId, null)
        }
      }
    } catch {
      // Silently ignore
    }
    setConfirmDiscard(null)
  }, [cwd, activeSessionId, setGitStatus, gitSelectedFile, setGitSelectedFile])

  const handleContextMenuAction = useCallback((action: 'stage-unstage' | 'discard') => {
    if (!contextMenu) return
    if (action === 'discard') {
      const target = contextMenu.target
      setContextMenu(null)
      setConfirmDiscard(target)
    } else if (action === 'stage-unstage' && contextMenu.target.kind === 'file') {
      const file = contextMenu.target.file
      setContextMenu(null)
      if (isStaged(file)) {
        window.api.gitUnstageFile(cwd!, file.path).then(() =>
          window.api.gitGetStatus(cwd!).then((s) => setGitStatus(activeSessionId!, s))
        )
      } else {
        window.api.gitStageFile(cwd!, file.path).then(() =>
          window.api.gitGetStatus(cwd!).then((s) => setGitStatus(activeSessionId!, s))
        )
      }
    }
  }, [contextMenu, cwd, activeSessionId, setGitStatus])

  return (
    <GitFileTreeView
      tree={tree}
      filteredFiles={filteredFiles}
      gitSelectedFile={gitSelectedFile}
      gitFileFilter={gitFileFilter}
      contextMenu={contextMenu}
      contextMenuRef={contextMenuRef}
      confirmDiscard={confirmDiscard}
      onSelect={handleSelectFile}
      onToggleStage={handleToggleStage}
      onToggleStageDirFiles={handleToggleStageDirFiles}
      onFileContextMenu={handleFileContextMenu}
      onDirContextMenu={handleDirContextMenu}
      onContextMenuAction={handleContextMenuAction}
      onConfirmDiscard={() => confirmDiscard && executeDiscard(confirmDiscard)}
      onCancelDiscard={() => setConfirmDiscard(null)}
    />
  )
}
