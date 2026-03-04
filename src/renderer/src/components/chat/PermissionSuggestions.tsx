import type { PermissionSuggestion } from '../../../../shared/types'

const DESTINATION_LABELS: Record<string, string> = {
  userSettings: 'user settings',
  projectSettings: 'project settings',
  localSettings: 'local settings',
  session: 'this session',
  cliArg: 'CLI arg',
}

/**
 * Formats a single permission suggestion into a human-readable label.
 * e.g. "Allow Bash(npm install:*) -> user settings"
 */
export function formatSuggestionLabel(s: PermissionSuggestion): string {
  const dest = DESTINATION_LABELS[s.destination] || s.destination

  if (s.type === 'setMode' && s.mode) {
    return `Set mode to "${s.mode}" in ${dest}`
  }

  if (s.type === 'addDirectories' || s.type === 'removeDirectories') {
    const dirs = s.directories?.join(', ') || '...'
    const verb = s.type === 'addDirectories' ? 'Add' : 'Remove'
    return `${verb} directories [${dirs}] in ${dest}`
  }

  // addRules / replaceRules / removeRules
  const verb = s.type === 'removeRules' ? 'Remove' : (s.behavior || 'allow')
  const ruleTexts = (s.rules || []).map((r) => {
    if (r.ruleContent) return `${r.toolName}(${r.ruleContent})`
    return r.toolName
  })
  const rulesStr = ruleTexts.join(', ') || '...'
  const capitalize = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1)

  return `${capitalize(verb)} ${rulesStr} in ${dest}`
}

/**
 * Returns true if a suggestion is redundant given the current session state
 * (e.g. "Set mode to acceptEdits" when already in acceptEdits mode).
 */
function isRedundant(s: PermissionSuggestion, currentMode?: string): boolean {
  if (s.type === 'setMode' && s.mode && currentMode && s.mode === currentMode) return true
  return false
}

/**
 * Checkbox list for permission suggestions shown above the action buttons.
 * Used by both FloatingApproval and ToolCallBlock.
 */
export function AlwaysAllowSection({
  suggestions,
  checkedSuggestions,
  onToggle,
  currentMode,
}: {
  suggestions: PermissionSuggestion[]
  checkedSuggestions: boolean[]
  onToggle: (index: number) => void
  currentMode?: string
}): React.JSX.Element | null {
  // Filter out redundant suggestions, keeping original indices for toggle callbacks
  const visible = suggestions
    .map((s, i) => ({ suggestion: s, index: i }))
    .filter(({ suggestion }) => !isRedundant(suggestion, currentMode))

  if (visible.length === 0) return null

  return (
    <div className="mt-2 space-y-1">
      <div className="text-[10px] text-text-muted/60 uppercase tracking-wider font-semibold">
        Permission rules
      </div>
      {visible.map(({ suggestion, index }) => (
        <label
          key={index}
          className="flex items-start gap-2 cursor-default select-none group"
        >
          <input
            type="checkbox"
            checked={checkedSuggestions[index]}
            onChange={() => onToggle(index)}
            className="w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer mt-0.5 shrink-0"
          />
          <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors leading-relaxed">
            {formatSuggestionLabel(suggestion)}
          </span>
        </label>
      ))}
    </div>
  )
}
