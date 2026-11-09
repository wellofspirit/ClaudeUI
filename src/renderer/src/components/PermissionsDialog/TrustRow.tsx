import type { WorkspaceTrust } from '../../../../shared/types'
import { ToggleSwitch } from '../SettingsDialog/settings-controls'

export interface TrustRowProps {
  trust: WorkspaceTrust
  saving: boolean
  error: string | null
  /** The session's cwd, to show where inside the trusted root a worktree session runs. */
  cwd: string | null
  onToggle: () => void
  /** Horizontal padding: the desktop dialog and the mobile view differ. */
  padX: string
}

/** cwd relative to the trust root when inside it (either separator), else the cwd itself. */
function relativeToRoot(cwd: string, root: string): string {
  const c = cwd.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return c.startsWith(r + '/') ? c.slice(r.length + 1) : cwd
}

function ShieldIcon({ trusted }: { trusted: boolean }): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 mt-[2px] ${trusted ? 'text-success' : 'text-warning'}`}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {trusted ? (
        <path d="m9 12 2 2 4-4" />
      ) : (
        <>
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </>
      )}
    </svg>
  )
}

/**
 * Workspace-trust toggle row (replaces the old untrusted warning). Trust is
 * recorded in ~/.claude.json and saved immediately, independent of the dialog's
 * Save button. The caller owns the optimistic state; `trust.trusted` is what the
 * switch shows.
 */
export function TrustRow({
  trust,
  saving,
  error,
  cwd,
  onToggle,
  padX
}: TrustRowProps): React.JSX.Element {
  const trusted = trust.trusted
  const tone = trusted ? 'border-border bg-bg-secondary/30' : 'border-warning/30 bg-warning/10'
  return (
    <div
      data-testid="PermissionsDialog.trust"
      data-state={trusted ? 'trusted' : 'untrusted'}
      className={`shrink-0 flex items-start gap-3 ${padX} py-3 border-b ${tone}`}
    >
      <ShieldIcon trusted={trusted} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[12px] font-medium ${trusted ? 'text-text-primary' : 'text-warning'}`}
          >
            Trust this workspace
          </span>
          <span
            data-testid="PermissionsDialog.trustRoot"
            className={`font-mono text-[10.5px] px-1.5 py-[1px] rounded break-all ${trusted ? 'bg-text-muted/20 text-text-secondary' : 'bg-warning/15 text-warning'}`}
          >
            {trust.root}
          </span>
        </div>
        {error ? (
          <div
            data-testid="PermissionsDialog.trustError"
            className="mt-1 text-[11px] leading-relaxed text-danger"
          >
            Could not update the Claude Code config: {error}
          </div>
        ) : (
          <div
            className={`mt-1 text-[11px] leading-relaxed ${trusted ? 'text-text-secondary' : 'text-warning'}`}
          >
            {trusted ? (
              'Claude Code applies Allow rules and added directories from the Project and Local scopes.'
            ) : (
              <>
                Not trusted, so Claude Code ignores every{' '}
                <strong className="font-semibold">Allow</strong> rule and added directory from the
                Project scope, and from Local too if{' '}
                <code className="font-mono">settings.local.json</code> is committed to git. Deny and
                Ask rules still apply, as do Global allows.
              </>
            )}
          </div>
        )}
        {trust.worktree && (
          <div
            data-testid="PermissionsDialog.trustWorktree"
            className="mt-1 text-[10.5px] text-text-muted leading-relaxed"
          >
            This session runs in the worktree{' '}
            <code className="font-mono">{cwd ? relativeToRoot(cwd, trust.root) : trust.root}</code>.
            Trust is recorded on the main checkout and covers all of its worktrees.
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 mt-[1px]">
        {saving && (
          <span
            data-testid="PermissionsDialog.trustSaving"
            className="inline-flex items-center gap-1.5 text-[10.5px] text-text-muted"
          >
            <span className="w-[11px] h-[11px] rounded-full border-[1.5px] border-text-muted border-t-accent animate-spin" />
            Saving
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={trusted}
          aria-label="Trust this workspace"
          data-testid="PermissionsDialog.trustToggle"
          disabled={saving}
          onClick={onToggle}
          className="disabled:opacity-40 cursor-default"
        >
          <ToggleSwitch checked={trusted} />
        </button>
      </div>
    </div>
  )
}
