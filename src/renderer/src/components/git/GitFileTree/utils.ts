import type { GitFileStatus } from '../../../../../shared/types'

// ── Tree data structures ────────────────────────────────────────────

export interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file?: GitFileStatus
}

// ── Pure tree-building utilities ────────────────────────────────────

export function buildTree(files: GitFileStatus[]): TreeNode[] {
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

export function flattenSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.file && node.children.length === 1 && !node.children[0].file) {
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

// ── File status helpers ─────────────────────────────────────────────

export function statusBadge(file: GitFileStatus): { char: string; color: string } {
  const s = file.index !== ' ' && file.index !== '?' ? file.index : file.working
  switch (s) {
    case 'M':
      return { char: 'M', color: 'text-yellow-400' }
    case 'A':
      return { char: 'A', color: 'text-green-400' }
    case 'D':
      return { char: 'D', color: 'text-red-400' }
    case 'R':
      return { char: 'R', color: 'text-blue-400' }
    case '?':
      return { char: 'U', color: 'text-green-400' }
    default:
      return { char: s || '?', color: 'text-text-muted' }
  }
}

export function isStaged(file: GitFileStatus): boolean {
  return file.index !== ' ' && file.index !== '?'
}

export function isUntracked(file: GitFileStatus): boolean {
  return file.index === '?' && file.working === '?'
}

/** Collect all GitFileStatus leaves under a tree node */
export function collectFiles(node: TreeNode): GitFileStatus[] {
  if (node.file) return [node.file]
  return node.children.flatMap(collectFiles)
}

// ── Context menu types ──────────────────────────────────────────────

export interface FileContextTarget {
  kind: 'file'
  file: GitFileStatus
}

export interface DirContextTarget {
  kind: 'dir'
  files: GitFileStatus[]
  dirName: string
}

export type ContextTarget = FileContextTarget | DirContextTarget

export interface ContextMenuState {
  x: number
  y: number
  target: ContextTarget
}

/** Build discard label based on target */
export function discardLabel(target: ContextTarget): string {
  if (target.kind === 'file') {
    return isUntracked(target.file) ? 'Delete file' : 'Discard changes'
  }
  const allUntracked = target.files.every(isUntracked)
  if (allUntracked) return `Delete ${target.files.length} files`
  return `Discard changes (${target.files.length} files)`
}

/** Build the confirmation dialog title */
export function discardDialogTitle(target: ContextTarget): string {
  if (target.kind === 'file') {
    return isUntracked(target.file) ? 'Delete untracked file?' : 'Discard changes?'
  }
  return target.files.every(isUntracked) ? 'Delete untracked files?' : 'Discard changes?'
}

/** Filter files based on staged/unstaged/all filter, sorted by path */
export function filterAndSortFiles(
  files: GitFileStatus[],
  filter: 'staged' | 'unstaged' | 'all'
): GitFileStatus[] {
  let filtered: GitFileStatus[]
  switch (filter) {
    case 'staged':
      filtered = files.filter((f) => isStaged(f))
      break
    case 'unstaged':
      filtered = files.filter((f) => !isStaged(f) || f.working !== ' ')
      break
    default:
      filtered = files
  }
  return [...filtered].sort((a, b) => a.path.localeCompare(b.path))
}
