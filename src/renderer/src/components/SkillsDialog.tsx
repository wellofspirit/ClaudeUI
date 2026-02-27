import { useState, useEffect, useCallback, useMemo } from 'react'
import type { SkillInfo, SkillSource } from '../../../shared/types'
import { MarkdownRenderer } from './chat/MarkdownRenderer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillsDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
}

interface SkillGroup {
  source: SkillSource
  label: string
  pathHint: string
  skills: SkillInfo[]
}

// ---------------------------------------------------------------------------
// Source display config
// ---------------------------------------------------------------------------

const SOURCE_ORDER: SkillSource[] = ['project', 'user', 'plugin', 'bundled']

const SOURCE_META: Record<SkillSource, { label: string; icon: string }> = {
  project: { label: 'PROJECT', icon: '\u26A1' },   // ⚡
  user:    { label: 'USER',    icon: '\u26A1' },   // ⚡
  plugin:  { label: 'PLUGINS', icon: '\uD83D\uDD0C' }, // 🔌
  bundled: { label: 'BUNDLED', icon: '\uD83D\uDCE6' }, // 📦
}

function sourcePathHint(source: SkillSource, cwd: string | null): string {
  switch (source) {
    case 'project': return cwd ? `${cwd}/.claude/skills/` : '.claude/skills/'
    case 'user': return '~/.claude/skills/'
    case 'plugin': return 'Installed plugins'
    case 'bundled': return 'Built-in'
  }
}

// ---------------------------------------------------------------------------
// Source badge component
// ---------------------------------------------------------------------------

function SourceBadge({ source, pluginName }: { source: SkillSource; pluginName?: string }): React.JSX.Element {
  const colors: Record<SkillSource, string> = {
    project: 'bg-accent/15 text-accent',
    user:    'bg-purple-500/15 text-purple-400',
    plugin:  'bg-emerald-500/15 text-emerald-400',
    bundled: 'bg-text-muted/15 text-text-muted',
  }
  const labels: Record<SkillSource, string> = {
    project: 'Project',
    user:    'User',
    plugin:  pluginName ? `Plugin: ${pluginName}` : 'Plugin',
    bundled: 'Bundled',
  }

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[source]}`}>
      {labels[source]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skill row in the left panel
// ---------------------------------------------------------------------------

function SkillRow({
  skill,
  selected,
  onSelect
}: {
  skill: SkillInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const meta = SOURCE_META[skill.source]
  const displayName = skill.displayName || skill.name

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-lg transition-colors cursor-default ${
        selected
          ? 'bg-accent/10 border border-accent/30'
          : 'hover:bg-bg-hover border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-[12px]">{meta.icon}</span>
        <span className={`text-[12px] font-medium truncate ${selected ? 'text-accent' : 'text-text-primary'}`}>
          {displayName}
        </span>
      </div>
      {skill.description && (
        <div className="text-[11px] text-text-muted truncate mt-0.5 pl-[22px]">
          {skill.description}
        </div>
      )}
      {skill.source === 'plugin' && skill.pluginName && (
        <div className="text-[10px] text-text-muted/60 truncate mt-0.5 pl-[22px]">
          via {skill.pluginName}
        </div>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Empty state for right panel
// ---------------------------------------------------------------------------

function EmptyPreview(): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-text-muted">
      <div className="text-center">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2 opacity-40">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <p className="text-[12px]">Select a skill to preview</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function SkillsDialog({ open, onClose, cwd }: SkillsDialogProps): React.JSX.Element | null {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Load skills when dialog opens
  useEffect(() => {
    if (!open || !cwd) return
    setLoading(true)
    window.api.loadSkillDetails(cwd).then((result) => {
      setSkills(result)
      // Auto-select first skill
      if (result.length > 0 && !selected) {
        setSelected(result[0].name)
      }
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd])

  // Reset state when closed
  useEffect(() => {
    if (!open) {
      setFilter('')
    }
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Filtered skills
  const filteredSkills = useMemo(() => {
    if (!filter) return skills
    const q = filter.toLowerCase()
    return skills.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.displayName && s.displayName.toLowerCase().includes(q)) ||
      s.description.toLowerCase().includes(q)
    )
  }, [skills, filter])

  // Group by source
  const groups = useMemo<SkillGroup[]>(() => {
    const map = new Map<SkillSource, SkillInfo[]>()
    for (const s of filteredSkills) {
      const list = map.get(s.source) || []
      list.push(s)
      map.set(s.source, list)
    }
    return SOURCE_ORDER
      .filter((src) => map.has(src))
      .map((src) => ({
        source: src,
        label: SOURCE_META[src].label,
        pathHint: sourcePathHint(src, cwd),
        skills: map.get(src)!,
      }))
  }, [filteredSkills, cwd])

  // Selected skill object
  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === selected) ?? null,
    [skills, selected]
  )

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() },
    [onClose]
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 900, height: 560, maxHeight: '85vh', maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span className="text-[14px] font-medium text-text-primary">Skills</span>
            <span className="text-[11px] text-text-muted">{skills.length} loaded</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body: dual panels */}
        <div className="flex-1 flex min-h-0">
          {/* Left panel: skill list */}
          <div className="w-[280px] shrink-0 border-r border-border flex flex-col">
            {/* Filter input */}
            <div className="px-3 py-2.5 border-b border-border">
              <div className="relative">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  placeholder="Filter skills..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-md bg-bg-secondary border border-border text-[12px] text-text-primary placeholder-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                />
              </div>
            </div>

            {/* Scrollable list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
              {loading && (
                <div className="flex items-center justify-center py-8 text-text-muted text-[12px]">
                  Loading skills...
                </div>
              )}
              {!loading && groups.length === 0 && (
                <div className="flex items-center justify-center py-8 text-text-muted text-[12px]">
                  {filter ? 'No matching skills' : 'No skills found'}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.source}>
                  {/* Group header */}
                  <div className="flex items-baseline justify-between px-1 mb-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[10px] font-semibold text-text-muted tracking-wider">
                        {group.label}
                      </span>
                      <span className="text-[10px] text-text-muted/50">
                        {group.pathHint}
                      </span>
                    </div>
                    <span className="text-[10px] text-text-muted/50">{group.skills.length}</span>
                  </div>
                  {/* Skill rows */}
                  <div className="space-y-0.5">
                    {group.skills.map((skill) => (
                      <SkillRow
                        key={skill.name}
                        skill={skill}
                        selected={selected === skill.name}
                        onSelect={() => setSelected(skill.name)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right panel: preview */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedSkill ? (
              <>
                {/* Metadata header */}
                <div className="shrink-0 px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    <h2 className="text-[14px] font-semibold text-text-primary">
                      {selectedSkill.displayName || selectedSkill.name}
                    </h2>
                    <SourceBadge source={selectedSkill.source} pluginName={selectedSkill.pluginName} />
                  </div>
                  {selectedSkill.description && (
                    <p className="text-[11px] text-text-secondary mb-1.5">{selectedSkill.description}</p>
                  )}
                  {selectedSkill.path && (
                    <div className="text-[10px] text-text-muted/60 font-mono truncate" title={selectedSkill.path}>
                      {selectedSkill.path}
                    </div>
                  )}
                </div>

                {/* Markdown content */}
                <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px] leading-[1.6] text-text-primary">
                  <MarkdownRenderer content={selectedSkill.content} />
                </div>
              </>
            ) : (
              <EmptyPreview />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-2.5 border-t border-border text-[11px] text-text-muted">
          <span>
            {skills.length} skill{skills.length !== 1 ? 's' : ''} loaded
            {filter && filteredSkills.length !== skills.length && (
              <span> &middot; {filteredSkills.length} shown</span>
            )}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-md bg-bg-secondary hover:bg-bg-hover border border-border text-text-secondary hover:text-text-primary transition-colors cursor-default"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
