import { useState, useEffect, useCallback, useRef } from 'react'
import type { ClaudePermissions, PermissionScope } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PermissionsDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
  initialTab?: PermissionScope
}

type RuleCategory = 'allow' | 'deny' | 'ask'

const EMPTY_PERMS: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

const SCOPE_LABELS: Record<PermissionScope, string> = {
  local: 'Local',
  project: 'Project',
  user: 'Global'
}

const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  local: '.claude/settings.local.json (gitignored)',
  project: '.claude/settings.json (committed)',
  user: '~/.claude/settings.json (user-wide)'
}

// Common rule templates for the add helper
const RULE_TEMPLATES = [
  { label: 'Bash command', template: 'Bash(command:*)' },
  { label: 'Edit files', template: 'Edit' },
  { label: 'Edit in path', template: 'Edit(src/**)' },
  { label: 'Read files', template: 'Read' },
  { label: 'Write files', template: 'Write' },
  { label: 'Glob', template: 'Glob' },
  { label: 'WebFetch domain', template: 'WebFetch(domain:example.com)' },
  { label: 'WebSearch', template: 'WebSearch' },
  { label: 'MCP server', template: 'mcp__server__*' },
  { label: 'Task (subagent)', template: 'Task' }
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RulePill({
  value,
  onUpdate,
  onDelete
}: {
  value: string
  onUpdate: (newValue: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing, value])

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onUpdate(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="flex-1 min-w-0 text-[12px] font-mono bg-bg-input border border-accent/50 rounded px-2 py-1 text-text-primary outline-none"
          spellCheck={false}
        />
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-1 bg-bg-tertiary/60 rounded px-2.5 py-1 text-[12px] font-mono text-text-secondary hover:bg-bg-tertiary transition-colors">
      <span
        className="flex-1 min-w-0 truncate cursor-default"
        onDoubleClick={() => setEditing(true)}
        title={value}
      >
        {value}
      </span>
      <button
        onClick={() => setEditing(true)}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all cursor-default"
        title="Edit"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-danger transition-all cursor-default"
        title="Remove"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function AddRuleInput({
  onAdd,
  placeholder
}: {
  onAdd: (rule: string) => void
  placeholder: string
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowTemplates(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const commit = (): void => {
    const trimmed = value.trim()
    if (trimmed) {
      onAdd(trimmed)
      setValue('')
    }
  }

  return (
    <div ref={wrapperRef} className="relative flex items-center gap-1">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setValue('')
        }}
        placeholder={placeholder}
        className="flex-1 min-w-0 text-[12px] font-mono bg-bg-input border border-border rounded px-2 py-1 text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
        spellCheck={false}
      />
      <button
        onClick={() => setShowTemplates((s) => !s)}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        title="Insert template"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        onClick={commit}
        disabled={!value.trim()}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-accent disabled:opacity-30 transition-colors cursor-default"
        title="Add rule"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      {showTemplates && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-bg-primary border border-border rounded-lg shadow-lg py-1 min-w-[220px] animate-fade-in">
          {RULE_TEMPLATES.map((t) => (
            <button
              key={t.template}
              onClick={() => {
                setValue(t.template)
                setShowTemplates(false)
              }}
              className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors cursor-default"
            >
              <span className="text-text-secondary">{t.label}</span>
              <span className="text-text-muted ml-2 font-mono text-[11px]">{t.template}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleSection({
  label,
  labelColor,
  rules,
  onUpdate,
  onDelete,
  onAdd,
  addPlaceholder
}: {
  label: string
  labelColor: string
  rules: string[]
  onUpdate: (index: number, value: string) => void
  onDelete: (index: number) => void
  onAdd: (rule: string) => void
  addPlaceholder: string
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${labelColor}`}>
          {label}
        </span>
        <span className="text-[10px] text-text-muted">
          {rules.length} rule{rules.length !== 1 ? 's' : ''}
        </span>
      </div>
      {rules.length > 0 && (
        <div className="space-y-1">
          {rules.map((rule, i) => (
            <RulePill
              key={`${rule}-${i}`}
              value={rule}
              onUpdate={(v) => onUpdate(i, v)}
              onDelete={() => onDelete(i)}
            />
          ))}
        </div>
      )}
      <AddRuleInput onAdd={onAdd} placeholder={addPlaceholder} />
    </div>
  )
}

function DirectoriesSection({
  dirs,
  onUpdate,
  onDelete,
  onAdd
}: {
  dirs: string[]
  onUpdate: (index: number, value: string) => void
  onDelete: (index: number) => void
  onAdd: (dir: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Additional Directories
        </span>
        <span className="text-[10px] text-text-muted">
          {dirs.length} path{dirs.length !== 1 ? 's' : ''}
        </span>
      </div>
      {dirs.length > 0 && (
        <div className="space-y-1">
          {dirs.map((dir, i) => (
            <RulePill
              key={`${dir}-${i}`}
              value={dir}
              onUpdate={(v) => onUpdate(i, v)}
              onDelete={() => onDelete(i)}
            />
          ))}
        </div>
      )}
      <AddRuleInput onAdd={onAdd} placeholder="/absolute/path/to/directory" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function PermissionsDialog({
  open,
  onClose,
  cwd,
  initialTab
}: PermissionsDialogProps): React.JSX.Element | null {
  const [activeTab, setActiveTab] = useState<PermissionScope>(initialTab ?? 'local')
  const [permsMap, setPermsMap] = useState<Record<PermissionScope, ClaudePermissions>>({
    local: { ...EMPTY_PERMS },
    project: { ...EMPTY_PERMS },
    user: { ...EMPTY_PERMS }
  })
  const [dirty, setDirty] = useState<Record<PermissionScope, boolean>>({
    local: false,
    project: false,
    user: false
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Track whether we've loaded at least once
  const loaded = useRef(false)

  // Available tabs — project/local only available when cwd is set
  const tabs: PermissionScope[] = cwd ? ['local', 'project', 'user'] : ['user']

  // Reset active tab when cwd or initialTab changes
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
    else if (!cwd && activeTab !== 'user') setActiveTab('user')
  }, [cwd, initialTab, activeTab])

  // Load all scopes on open
  useEffect(() => {
    if (!open) {
      loaded.current = false
      return
    }

    async function load(): Promise<void> {
      setLoading(true)
      try {
        const [user, project, local] = await Promise.all([
          window.api.loadClaudePermissions('user'),
          cwd ? window.api.loadClaudePermissions('project', cwd) : Promise.resolve({ ...EMPTY_PERMS }),
          cwd ? window.api.loadClaudePermissions('local', cwd) : Promise.resolve({ ...EMPTY_PERMS })
        ])
        setPermsMap({ user, project, local })
        setDirty({ local: false, project: false, user: false })
        loaded.current = true
      } catch {
        // Silently use empty defaults
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [open, cwd])

  // Save a specific scope
  const saveScope = useCallback(
    async (scope: PermissionScope): Promise<void> => {
      if (!dirty[scope]) return
      setSaving(true)
      try {
        await window.api.saveClaudePermissions(scope, permsMap[scope], cwd ?? undefined)
        setDirty((d) => ({ ...d, [scope]: false }))
      } finally {
        setSaving(false)
      }
    },
    [dirty, permsMap, cwd]
  )

  // Save all dirty scopes
  const saveAll = useCallback(async (): Promise<void> => {
    for (const scope of tabs) {
      if (dirty[scope]) await saveScope(scope)
    }
  }, [tabs, dirty, saveScope])

  // Helper to update rules in a specific scope/category
  const updateRules = useCallback(
    (scope: PermissionScope, category: RuleCategory, updater: (rules: string[]) => string[]) => {
      setPermsMap((prev) => ({
        ...prev,
        [scope]: {
          ...prev[scope],
          [category]: updater(prev[scope][category])
        }
      }))
      setDirty((d) => ({ ...d, [scope]: true }))
    },
    []
  )

  const updateDirs = useCallback(
    (scope: PermissionScope, updater: (dirs: string[]) => string[]) => {
      setPermsMap((prev) => ({
        ...prev,
        [scope]: {
          ...prev[scope],
          additionalDirectories: updater(prev[scope].additionalDirectories)
        }
      }))
      setDirty((d) => ({ ...d, [scope]: true }))
    },
    []
  )

  // Close handler — save dirty scopes first
  const handleClose = useCallback(async () => {
    await saveAll()
    onClose()
  }, [saveAll, onClose])

  // Keyboard
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, handleClose])

  if (!open) return null

  const perms = permsMap[activeTab]
  const hasDirty = tabs.some((s) => dirty[s])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 680, maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span className="text-[14px] font-medium text-text-primary">Permissions</span>
          </div>
          <button
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex items-center gap-0 px-5 border-b border-border bg-bg-secondary/30">
          {tabs.map((scope) => (
            <button
              key={scope}
              onClick={async () => {
                await saveScope(activeTab)
                setActiveTab(scope)
              }}
              className={`relative px-4 py-2.5 text-[12px] font-medium transition-colors cursor-default ${
                activeTab === scope
                  ? 'text-accent'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {SCOPE_LABELS[scope]}
              {dirty[scope] && (
                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-accent" />
              )}
              {activeTab === scope && (
                <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-accent rounded-full" />
              )}
            </button>
          ))}
          <span className="flex-1" />
          <span className="text-[10px] text-text-muted font-mono truncate max-w-[280px]" title={SCOPE_DESCRIPTIONS[activeTab]}>
            {SCOPE_DESCRIPTIONS[activeTab]}
          </span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
              Loading permissions...
            </div>
          ) : (
            <>
              <RuleSection
                label="Allow"
                labelColor="text-success"
                rules={perms.allow}
                onUpdate={(i, v) => updateRules(activeTab, 'allow', (r) => r.map((x, j) => (j === i ? v : x)))}
                onDelete={(i) => updateRules(activeTab, 'allow', (r) => r.filter((_, j) => j !== i))}
                onAdd={(rule) => updateRules(activeTab, 'allow', (r) => [...r, rule])}
                addPlaceholder="e.g. Bash(git:*), Edit(src/**)"
              />

              <div className="border-t border-border/50" />

              <RuleSection
                label="Ask"
                labelColor="text-warning"
                rules={perms.ask}
                onUpdate={(i, v) => updateRules(activeTab, 'ask', (r) => r.map((x, j) => (j === i ? v : x)))}
                onDelete={(i) => updateRules(activeTab, 'ask', (r) => r.filter((_, j) => j !== i))}
                onAdd={(rule) => updateRules(activeTab, 'ask', (r) => [...r, rule])}
                addPlaceholder="e.g. Bash(git push:*)"
              />

              <div className="border-t border-border/50" />

              <RuleSection
                label="Deny"
                labelColor="text-danger"
                rules={perms.deny}
                onUpdate={(i, v) => updateRules(activeTab, 'deny', (r) => r.map((x, j) => (j === i ? v : x)))}
                onDelete={(i) => updateRules(activeTab, 'deny', (r) => r.filter((_, j) => j !== i))}
                onAdd={(rule) => updateRules(activeTab, 'deny', (r) => [...r, rule])}
                addPlaceholder="e.g. Bash(rm -rf /*)"
              />

              <div className="border-t border-border/50" />

              <DirectoriesSection
                dirs={perms.additionalDirectories}
                onUpdate={(i, v) => updateDirs(activeTab, (d) => d.map((x, j) => (j === i ? v : x)))}
                onDelete={(i) => updateDirs(activeTab, (d) => d.filter((_, j) => j !== i))}
                onAdd={(dir) => updateDirs(activeTab, (d) => [...d, dir])}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-border bg-bg-secondary/30">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Changes take effect on next session start
          </div>
          <div className="flex items-center gap-2">
            {hasDirty && (
              <button
                onClick={saveAll}
                disabled={saving}
                className="px-3 py-1.5 text-[12px] font-medium text-bg-primary bg-accent hover:bg-accent-hover rounded-md transition-colors cursor-default disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors cursor-default"
            >
              {hasDirty ? 'Save & Close' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
