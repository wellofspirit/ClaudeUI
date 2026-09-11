import { useState } from 'react'
import type { CodexSessionState, CodexSettings } from '../../../../shared/codex-types'
import { SelectMenu } from '../shared/SelectMenu'

/**
 * The trigger keeps the inline, content-sized shape the replaced `<select>` had
 * — these three sit side by side in one `flex flex-wrap` row, so `SelectMenu`'s
 * default `w-full` would stretch each label to the row width.
 */
const TRIGGER_CLASS =
  'block bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/** Displays native acknowledgements, never speculative requested policy. */
export function CodexPolicyPill({
  policy,
  routingId,
  onInitialize,
  connected = true
}: {
  policy?: CodexSessionState
  routingId?: string
  onInitialize?: () => Promise<void>
  connected?: boolean
}): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = async (settings: CodexSettings): Promise<void> => {
    if (!routingId) return
    setBusy(true)
    setError('')
    try {
      await window.api.codexSettings(routingId, settings)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Native settings rejected')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details data-testid="CodexPolicyPill" className="px-3 py-1 text-[11px] text-text-secondary">
      <summary data-testid="CodexPolicyPill.summary" className="cursor-pointer">
        {connected ? 'Native policy' : 'Last native policy'}:{' '}
        {policy
          ? typeof policy.approvalPolicy === 'string'
            ? policy.approvalPolicy
            : 'granular'
          : 'inherited, awaiting native status'}
      </summary>
      <div data-testid="CodexPolicyPill.effective" className="py-2 whitespace-pre-wrap break-all">
        {policy
          ? JSON.stringify(
              {
                approvalPolicy: policy.approvalPolicy,
                approvalsReviewer: policy.approvalsReviewer,
                sandbox: policy.sandbox,
                activePermissionProfile: policy.activePermissionProfile
              },
              null,
              2
            )
          : 'No approval, sandbox, or reviewer overrides requested.'}
        <p>
          {connected ? 'Effective' : 'Last observed'} native settings above. Shared permission modes
          do not apply. Choices below explicitly replace the selected setting for subsequent turns.
        </p>
      </div>
      {policy?.overrides && Object.keys(policy.overrides).length > 0 && (
        <div data-testid="CodexPolicyPill.saved" className="py-2 break-all">
          Explicit overrides for reconnect: {JSON.stringify(policy.overrides)}
        </div>
      )}
      {routingId &&
        (error ||
          (policy?.overrides && Object.keys(policy.overrides).some((key) => key !== 'model'))) && (
          <button
            data-testid="CodexPolicyPill.reset"
            disabled={busy}
            onClick={() => void apply({ reset: true })}
          >
            Stop replaying app policy/effort overrides (idle only; keeps model)
          </button>
        )}
      {policy?.overrides && Object.keys(policy.overrides).some((key) => key !== 'model') && (
        <p>Clearing app replay does not undo settings Codex itself has retained for this thread.</p>
      )}
      {(!policy || !connected) && onInitialize && routingId && (
        <div>
          <p>
            Initializing alone does not make an empty native thread cold-readable. Send a turn
            before relying on reopen.
          </p>
          <button
            data-testid="CodexPolicyPill.initialize"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await onInitialize()
              } catch (error) {
                setError(error instanceof Error ? error.message : 'Native policy could not be read')
              } finally {
                setBusy(false)
              }
            }}
          >
            Initialize without a prompt
          </button>
        </div>
      )}
      {policy && routingId && connected && (
        <div data-testid="CodexPolicyPill.controls" className="flex flex-wrap gap-3 pb-2">
          {/*
           * Both pickers stay VALUELESS on purpose: the pill displays native
           * acknowledgements, and picking is a one-shot request, not a bound
           * value. The "keep native …" placeholder is therefore a
           * `fallbackLabel` rather than an `''` option — a real empty option
           * would be clickable, and unlike a native select (which fires no
           * `change` for the already-selected entry) that click would apply an
           * EMPTY approvalPolicy/sandbox to the thread.
           */}
          <div>
            Approval policy
            <SelectMenu
              testid="CodexPolicyPill.approval"
              ariaLabel="Approval policy"
              value=""
              fallbackLabel="Keep native policy"
              disabled={busy}
              triggerClassName={TRIGGER_CLASS}
              options={[
                { value: 'untrusted', label: 'Untrusted commands' },
                { value: 'on-request', label: 'On request' },
                { value: 'never', label: 'Never request approval' }
              ]}
              onChange={(value) =>
                void apply({ approvalPolicy: value as CodexSettings['approvalPolicy'] })
              }
            />
          </div>
          <div>
            Sandbox
            <SelectMenu
              testid="CodexPolicyPill.sandbox"
              ariaLabel="Sandbox"
              value=""
              fallbackLabel="Keep native sandbox"
              disabled={busy}
              triggerClassName={TRIGGER_CLASS}
              options={[
                { value: 'read-only', label: 'Read-only, no network' },
                { value: 'workspace-write', label: 'Workspace write, no network' },
                { value: 'danger-full-access', label: 'Full access' }
              ]}
              onChange={(value) => void apply({ sandbox: value as CodexSettings['sandbox'] })}
            />
          </div>
          <button
            data-testid="CodexPolicyPill.reviewer"
            disabled={busy}
            onClick={() => void apply({ approvalsReviewer: 'user' })}
          >
            Use human reviewer
          </button>
          {policy.effortOptions.length > 0 && (
            <div>
              Native effort
              {/*
               * This one IS bound — it shows the acknowledged effort. The empty
               * entry stays an explicit DISABLED option, exactly as the
               * `<option value="" disabled>` it replaces: "no effort
               * acknowledged yet" must read as a label, never as a choice. An
               * acknowledged effort outside `effortOptions` falls back to its
               * own raw value rather than to that label.
               */}
              <SelectMenu
                testid="CodexPolicyPill.effort"
                ariaLabel="Native effort"
                value={policy.reasoningEffort ?? ''}
                disabled={busy}
                triggerClassName={TRIGGER_CLASS}
                options={[
                  { value: '', label: 'Native default', disabled: true },
                  ...policy.effortOptions.map((option) => ({
                    value: option.value,
                    label: `${option.value}: ${option.description}`
                  }))
                ]}
                onChange={(value) => void apply({ effort: value })}
              />
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  )
}
