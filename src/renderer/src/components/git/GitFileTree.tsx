import { useState, useCallback, useMemo } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { GitFileStatus } from '../../../../shared/types'

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file?: GitFileStatus
}

function buildTree(files: GitFileStatus[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isFile = i === parts.length - 1
      let node = current.find((n) => n.name === name)
      if (!node) {
        node = {
          name,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
          file: isFile ? file : undefined
        }
        current.push(node)
      }
      current = node.children
    }
  }
  return root
}

function flattenSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.file && node.children.length === 1 && !node.children[0].file) {
      // Merge single-child directories
      const child = node.children[0]
      return {
        ...child,
        name: `${node.name}/${child.name}`,
        children: flattenSingleChildDirs(child.children)
      }
    }
    return { ...node, children: flattenSingleChildDirs(node.children) }
  })
}

function statusBadge(file: GitFileStatus): { char: string; color: string } {
  // Prefer showing the most significant status
  const s = file.index !== ' ' && file.index !== '?' ? file.index : file.working
  switch (s) {
    case 'M': return { char: 'M', color: 'text-yellow-400' }
    case 'A': return { char: 'A', color: 'text-green-400' }
    case 'D': return { char: 'D', color: 'text-red-400' }
    case 'R': return { char: 'R', color: 'text-blue-400' }
    case '?': return { char: 'U', color: 'text-green-400' }
    default: return { char: s || '?', color: 'text-text-muted' }
  }
}

function isStaged(file: GitFileStatus): boolean {
  return file.index !== ' ' && file.index !== '?'
}

/** Collect all GitFileStatus leaves under a tree node */
function collectFiles(node: TreeNode): GitFileStatus[] {
  if (node.file) return [node.file]
  return node.children.flatMap(collectFiles)
}

export function GitFileTree(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitFileFilter = useActiveSession((s) => s.gitFileFilter)
  const gitSelectedFile = useActiveSession((s) => s.gitSelectedFile)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitSelectedFile = useSessionStore((s) => s.setGitSelectedFile)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)

  const filteredFiles = useMemo(() => {
    if (!gitStatus) return []
    let files: GitFileStatus[]
    switch (gitFileFilter) {
      case 'staged':
        files = gitStatus.files.filter((f) => isStaged(f))
        break
      case 'unstaged':
        files = gitStatus.files.filter((f) => !isStaged(f) || f.working !== ' ')
        break
      default:
        files = gitStatus.files
    }
    // Sort alphabetically by path so order is stable across status refreshes
    return [...files].sort((a, b) => a.path.localeCompare(b.path))
  }, [gitStatus, gitFileFilter])

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

  if (filteredFiles.length === 0) {
    return (
      <div className="p-4 text-[12px] text-text-muted text-center">
        No {gitFileFilter !== 'all' ? gitFileFilter : ''} changes
      </div>
    )
  }

  return (
    <div className="py-0.5 font-mono">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={0}
          selectedFile={gitSelectedFile}
          onSelect={handleSelectFile}
          onToggleStage={handleToggleStage}
          onToggleStageDirFiles={handleToggleStageDirFiles}
        />
      ))}
    </div>
  )
}

function TreeNodeItem({
  node,
  depth,
  selectedFile,
  onSelect,
  onToggleStage,
  onToggleStageDirFiles
}: {
  node: TreeNode
  depth: number
  selectedFile: string | null
  onSelect: (path: string) => void
  onToggleStage: (file: GitFileStatus, e: React.MouseEvent) => void
  onToggleStageDirFiles: (files: GitFileStatus[], stage: boolean, e: React.MouseEvent) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)

  if (node.file) {
    // File node
    const badge = statusBadge(node.file)
    const staged = isStaged(node.file)
    const isSelected = selectedFile === node.file.path
    return (
      <button
        onClick={() => onSelect(node.file!.path)}
        className={`w-full text-left flex items-center gap-1 px-1.5 py-0 text-[11px] leading-[18px] transition-colors cursor-default group ${
          isSelected ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          onClick={(e) => onToggleStage(node.file!, e)}
          className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm border transition-colors ${
            staged
              ? 'bg-accent/30 border-accent text-accent'
              : 'border-border text-transparent hover:border-text-muted hover:text-text-muted'
          }`}
          title={staged ? 'Unstage' : 'Stage'}
        >
          {staged && (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        <span className={`w-3.5 text-center font-mono text-[9px] font-bold shrink-0 ${badge.color}`}>
          {badge.char}
        </span>
        <span className="truncate flex-1">{node.name}</span>
      </button>
    )
  }

  // Directory node
  const dirFiles = collectFiles(node)
  const dirAllStaged = dirFiles.length > 0 && dirFiles.every(isStaged)
  const dirSomeStaged = dirFiles.some(isStaged)
  return (
    <div>
      <div
        className="w-full text-left flex items-center gap-1 px-1.5 py-0 text-[11px] leading-[18px] text-text-muted hover:bg-bg-hover transition-colors cursor-default"
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStageDirFiles(dirFiles, !dirAllStaged, e) }}
          className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm border transition-colors ${
            dirAllStaged
              ? 'bg-accent/30 border-accent text-accent'
              : dirSomeStaged
                ? 'bg-accent/15 border-accent/50 text-accent/50'
                : 'border-border text-transparent hover:border-text-muted hover:text-text-muted'
          }`}
          title={dirAllStaged ? 'Unstage directory' : 'Stage directory'}
        >
          {dirAllStaged && (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {dirSomeStaged && !dirAllStaged && (
            <svg width="6" height="6" viewBox="0 0 12 12" fill="currentColor">
              <rect x="1" y="5" width="10" height="2" rx="1" />
            </svg>
          )}
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 flex-1 min-w-0"
        >
          <svg
            width="8" height="8" viewBox="0 0 12 12" fill="currentColor"
            className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
          <span className="truncate">{node.name}/</span>
        </button>
      </div>
      {expanded && node.children.map((child) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onSelect={onSelect}
          onToggleStage={onToggleStage}
          onToggleStageDirFiles={onToggleStageDirFiles}
        />
      ))}
    </div>
  )
}
