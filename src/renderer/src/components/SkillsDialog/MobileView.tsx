import { useMemo, useState } from 'react'
import type { SkillInfo, SkillSource } from '../../../../shared/types'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import type { SkillsDialogViewProps } from './View'

/**
 * Mobile (viewport ≤768px) Skills UI — ADR-048's takeover + drill-down pattern.
 *
 * The desktop dialog is a fixed 900×560 box: a 280px skill list beside a
 * markdown preview. A phone fits one of those, so this is two screens:
 *
 *   List (selected === null) → tap a skill → Detail → "Skills" back →
 *
 * Selection is LOCAL state here, unlike the MCP fork: the desktop Skills view
 * owns its own `selected`/`filter` (the container only ships skills + loading),
 * so there is no shared selection to derive from and nothing to keep in sync.
 * Unlike desktop it does NOT auto-select the first skill — that would land a
 * phone on a preview nobody asked for (the MobileGitView rule).
 *
 * The filter input IS kept (skill lists routinely run to dozens once plugins
 * and bundled skills are counted) and sits directly under the header, where a
 * soft keyboard can never cover it — ADR-048 Decision 4's top-anchored case,
 * same placement the mobile Settings search uses.
 *
 * Content is read-only, exactly as desktop renders it: same MarkdownRenderer,
 * same fields.
 */

/**
 * Group order + captions.
 *
 * Duplicated from `View.tsx` rather than imported, because that file must stay
 * byte-identical in this change; if it is ever touched, these and its private
 * SOURCE_ORDER/SOURCE_META should become one exported pair.
 */
const SOURCE_ORDER: SkillSource[] = ['project', 'user', 'plugin', 'bundled']

const SOURCE_LABELS: Record<SkillSource, string> = {
  project: 'PROJECT',
  user: 'USER',
  plugin: 'PLUGINS',
  bundled: 'BUNDLED'
}

const SOURCE_BADGE_LABELS: Record<SkillSource, string> = {
  project: 'Project',
  user: 'User',
  plugin: 'Plugin',
  bundled: 'Bundled'
}

const SOURCE_BADGE_COLORS: Record<SkillSource, string> = {
  project: 'bg-accent/15 text-accent',
  user: 'bg-purple-500/15 text-purple-400',
  plugin: 'bg-emerald-500/15 text-emerald-400',
  bundled: 'bg-text-muted/15 text-text-muted'
}

function CrossIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }): React.JSX.Element {
  return (
    <svg
      width={dir === 'left' ? 18 : 14}
      height={dir === 'left' ? 18 : 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {dir === 'left' ? (
        <polyline points="15 18 9 12 15 6" />
      ) : (
        <polyline points="9 18 15 12 9 6" />
      )}
    </svg>
  )
}

export function SkillsMobileView({
  skills,
  loading,
  onClose
}: SkillsDialogViewProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const filteredSkills = useMemo(() => {
    if (!filter) return skills
    const q = filter.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.displayName && s.displayName.toLowerCase().includes(q)) ||
        s.description.toLowerCase().includes(q)
    )
  }, [skills, filter])

  const groups = useMemo(() => {
    const map = new Map<SkillSource, SkillInfo[]>()
    for (const s of filteredSkills) {
      const list = map.get(s.source) || []
      list.push(s)
      map.set(s.source, list)
    }
    return SOURCE_ORDER.filter((src) => map.has(src)).map((src) => ({
      source: src,
      label: SOURCE_LABELS[src],
      skills: map.get(src)!
    }))
  }, [filteredSkills])

  // Derived, not stored: a skill that disappears (cwd change reloads the list)
  // takes the detail screen back to the list instead of stranding it.
  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === selected) ?? null,
    [skills, selected]
  )

  // ── Detail screen ────────────────────────────────────────────────────────
  if (selectedSkill) {
    const skill = selectedSkill
    return (
      <div
        data-testid="SkillsMobileView"
        className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
      >
        <div
          className="shrink-0 flex items-center gap-1 px-3 h-12 border-b border-border"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <button
            data-testid="SkillsMobileView.back"
            onClick={() => setSelected(null)}
            className="flex items-center gap-1 shrink-0 -ml-1 px-1 py-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            <Chevron dir="left" />
            <span className="text-[13px] font-medium">Skills</span>
          </button>
          <span className="flex-1 min-w-0 text-[13px] text-text-primary font-medium truncate text-right">
            {skill.displayName || skill.name}
          </span>
          <button
            data-testid="SkillsMobileView.close"
            onClick={onClose}
            className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <CrossIcon />
          </button>
        </div>

        <div
          data-testid="SkillsMobileView.detail"
          data-id={skill.name}
          className="flex-1 overflow-y-auto"
        >
          <div className="px-3 py-3 border-b border-border/50 space-y-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[14px] font-semibold text-text-primary min-w-0 truncate">
                {skill.displayName || skill.name}
              </span>
              {/* A long "Plugin: <name>" must not push the title off a 360px
                  screen. The ellipsis has to live on an INNER block-level span:
                  text-overflow does nothing on the inline-flex badge itself,
                  which only caps the width. */}
              <span
                className={`inline-flex items-center shrink-0 max-w-[45%] px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_BADGE_COLORS[skill.source]}`}
              >
                <span className="min-w-0 truncate">
                  {skill.source === 'plugin' && skill.pluginName
                    ? `Plugin: ${skill.pluginName}`
                    : SOURCE_BADGE_LABELS[skill.source]}
                </span>
              </span>
            </div>
            {skill.description && (
              <p className="text-[11px] text-text-secondary break-words">{skill.description}</p>
            )}
            {skill.path && (
              <div className="text-[10px] text-text-muted/60 font-mono break-all">{skill.path}</div>
            )}
          </div>
          <div className="px-3 py-3 text-[12px] leading-[1.6] text-text-primary">
            <MarkdownRenderer content={skill.content} />
          </div>
        </div>
      </div>
    )
  }

  // ── List screen ──────────────────────────────────────────────────────────
  return (
    <div
      data-testid="SkillsMobileView"
      className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
    >
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent shrink-0"
        >
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span className="flex-1 min-w-0 text-[14px] font-medium text-text-primary truncate">
          Skills
          {skills.length > 0 && (
            <span className="text-text-muted text-[11px] font-normal"> · {skills.length}</span>
          )}
        </span>
        <button
          data-testid="SkillsMobileView.close"
          onClick={onClose}
          className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
          title="Close"
        >
          <CrossIcon />
        </button>
      </div>

      {/* Never autofocused: a soft keyboard covering the list the user came to
          browse is not a helpful way to open the screen. */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50">
        <input
          data-testid="SkillsMobileView.filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter skills…"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="w-full bg-bg-input border border-border/50 rounded-md px-2.5 py-2 text-[13px] text-text-secondary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
            Loading skills...
          </div>
        )}
        {!loading && groups.length === 0 && (
          <div className="flex items-center justify-center px-6 py-12 text-center text-text-muted text-[13px]">
            {filter ? 'No matching skills' : 'No skills found'}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.source}>
            <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-text-muted/60">
              {group.label}
            </div>
            {group.skills.map((skill) => (
              <button
                key={skill.name}
                data-testid="SkillsMobileView.row"
                data-id={skill.name}
                onClick={() => setSelected(skill.name)}
                className="w-full flex items-center gap-2 text-left px-3 py-2.5 min-h-[52px] border-b border-border/40"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-text-primary truncate">
                    {skill.displayName || skill.name}
                  </span>
                  {skill.description && (
                    <span className="block text-[11px] text-text-muted truncate">
                      {skill.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-text-muted/50">
                  <Chevron dir="right" />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
