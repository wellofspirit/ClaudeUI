import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitFileStatus } from '../../../../../shared/types'
import {
  type TreeNode,
  type ContextMenuState,
  type ContextTarget,
  statusBadge,
  isStaged,
  isUntracked,
  collectFiles,
  discardLabel,
  discardDialogTitle
} from './utils'

// ── View props ──────────────────────────────────────────────────────

export interface GitFileTreeViewProps {
  tree: TreeNode[]
  filteredFiles: GitFileStatus[]
  gitSelectedFile: string | null
  gitFileFilter: 'staged' | 'unstaged' | 'all'
  contextMenu: ContextMenuState | null
  contextMenuRef: React.RefObject<HTMLDivElement | null>
  confirmDiscard: ContextTarget | null
  onSelect: (path: string) => void
  onToggleStage: (file: GitFileStatus, e: React.MouseEvent) => void
  onToggleStageDirFiles: (files: GitFileStatus[], stage: boolean, e: React.MouseEvent) => void
  onFileContextMenu: (file: GitFileStatus, e: React.MouseEvent) => void
  onDirContextMenu: (files: GitFileStatus[], dirName: string, e: React.MouseEvent) => void
  onContextMenuAction: (action: 'stage-unstage' | 'discard') => void
  onConfirmDiscard: () => void
  onCancelDiscard: () => void
}

export function GitFileTreeView({
  tree,
  filteredFiles,
  gitSelectedFile,
  gitFileFilter,
  contextMenu,
  contextMenuRef,
  confirmDiscard,
  onSelect,
  onToggleStage,
  onToggleStageDirFiles,
  onFileContextMenu,
  onDirContextMenu,
  onContextMenuAction,
  onConfirmDiscard,
  onCancelDiscard
}: GitFileTreeViewProps): React.JSX.Element {
  if (filteredFiles.length === 0) {
    return (
      <div data-testid="GitFileTree" className="p-4 text-[12px] text-text-muted text-center">
        No {gitFileFilter !== 'all' ? gitFileFilter : ''} changes
      </div>
    )
  }

  return (
    <div data-testid="GitFileTree" className="py-0.5 font-mono">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={0}
          selectedFile={gitSelectedFile}
          onSelect={onSelect}
          onToggleStage={onToggleStage}
          onToggleStageDirFiles={onToggleStageDirFiles}
          onFileContextMenu={onFileContextMenu}
          onDirContextMenu={onDirContextMenu}
        />
      ))}

      {/* Context menu — portaled to body to escape overflow:hidden ancestors */}
      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            className="fixed z-50 py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg grid"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.target.kind === 'file' && (
              <button
                className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                onClick={() => onContextMenuAction('stage-unstage')}
              >
                {contextMenu.target.kind === 'file' && isStaged(contextMenu.target.file)
                  ? 'Unstage'
                  : 'Stage'}
              </button>
            )}
            <button
              className="w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:text-red-300 hover:bg-bg-hover transition-colors cursor-default"
              onClick={() => onContextMenuAction('discard')}
            >
              {discardLabel(contextMenu.target)}
            </button>
          </div>,
          document.body
        )}

      {/* Confirmation dialog — portaled to root */}
      {confirmDiscard &&
        createPortal(
          <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <div className="bg-bg-secondary border border-border rounded-xl w-[380px] flex flex-col shadow-2xl shadow-black/40 overflow-hidden">
              <div className="px-4 pt-4 pb-2">
                <h3 className="text-[14px] font-semibold text-text-primary">
                  {discardDialogTitle(confirmDiscard)}
                </h3>
              </div>
              <div className="px-4 py-2 text-[12px] text-text-secondary">
                {confirmDiscard.kind === 'file' ? (
                  <p>
                    {isUntracked(confirmDiscard.file) ? (
                      <>
                        This will permanently delete{' '}
                        <span className="font-mono text-text-primary">
                          {confirmDiscard.file.path}
                        </span>
                        .
                      </>
                    ) : (
                      <>
                        This will discard all changes to{' '}
                        <span className="font-mono text-text-primary">
                          {confirmDiscard.file.path}
                        </span>
                        , restoring it to the last committed state.
                      </>
                    )}
                  </p>
                ) : (
                  <p>
                    This will{' '}
                    {confirmDiscard.files.every(isUntracked)
                      ? 'permanently delete'
                      : 'discard all changes to'}{' '}
                    <span className="font-mono text-text-primary">
                      {confirmDiscard.files.length} files
                    </span>{' '}
                    in{' '}
                    <span className="font-mono text-text-primary">{confirmDiscard.dirName}/</span>.
                  </p>
                )}
                <p className="mt-1.5 text-text-muted">This action cannot be undone.</p>
              </div>
              <div className="flex justify-end gap-2 px-4 py-3">
                <button
                  className="px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                  onClick={onCancelDiscard}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-1.5 text-[12px] text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
                  onClick={onConfirmDiscard}
                >
                  {confirmDiscard.kind === 'file' && isUntracked(confirmDiscard.file)
                    ? 'Delete'
                    : confirmDiscard.kind === 'dir' && confirmDiscard.files.every(isUntracked)
                      ? 'Delete'
                      : 'Discard'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

// ── TreeNodeItem (sub-component, tightly coupled to View) ───────────

function TreeNodeItem({
  node,
  depth,
  selectedFile,
  onSelect,
  onToggleStage,
  onToggleStageDirFiles,
  onFileContextMenu,
  onDirContextMenu
}: {
  node: TreeNode
  depth: number
  selectedFile: string | null
  onSelect: (path: string) => void
  onToggleStage: (file: GitFileStatus, e: React.MouseEvent) => void
  onToggleStageDirFiles: (files: GitFileStatus[], stage: boolean, e: React.MouseEvent) => void
  onFileContextMenu: (file: GitFileStatus, e: React.MouseEvent) => void
  onDirContextMenu: (files: GitFileStatus[], dirName: string, e: React.MouseEvent) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)

  if (node.file) {
    const badge = statusBadge(node.file)
    const staged = isStaged(node.file)
    const isSelected = selectedFile === node.file.path
    return (
      <button
        data-testid="GitFileRow"
        data-id={node.file.path}
        onClick={() => onSelect(node.file!.path)}
        onContextMenu={(e) => onFileContextMenu(node.file!, e)}
        className={`w-full text-left flex items-center gap-1 px-1.5 py-0 text-[11px] leading-[18px] transition-colors cursor-default group ${
          isSelected ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          data-testid="GitFileRow.stageToggle"
          onClick={(e) => onToggleStage(node.file!, e)}
          className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm border transition-colors ${
            staged
              ? 'bg-accent/30 border-accent text-accent'
              : 'border-border text-transparent hover:border-text-muted hover:text-text-muted'
          }`}
          title={staged ? 'Unstage' : 'Stage'}
        >
          {staged && (
            <svg
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        <span
          className={`w-3.5 text-center font-mono text-[9px] font-bold shrink-0 ${badge.color}`}
        >
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
        onContextMenu={(e) => onDirContextMenu(dirFiles, node.name, e)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleStageDirFiles(dirFiles, !dirAllStaged, e)
          }}
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
            <svg
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
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
            width="8"
            height="8"
            viewBox="0 0 12 12"
            fill="currentColor"
            className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
          <span className="truncate">{node.name}/</span>
        </button>
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeNodeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onSelect={onSelect}
            onToggleStage={onToggleStage}
            onToggleStageDirFiles={onToggleStageDirFiles}
            onFileContextMenu={onFileContextMenu}
            onDirContextMenu={onDirContextMenu}
          />
        ))}
    </div>
  )
}
