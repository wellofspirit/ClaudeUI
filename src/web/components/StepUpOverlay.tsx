import { useEffect, useState } from 'react'
import { StepUpPrompt } from '@renderer/components/shared/StepUpPrompt'
import type { StepUpDemand, StepUpGate } from '../step-up-gate'
import type { RemoteConnection } from '../connection'

/**
 * The generic "confirm it's you" surface (ADR-054 series 2).
 *
 * The gate (`step-up-gate.ts`) turns a `needs-step-up` refusal — from ANY invoke
 * — into one pending demand; this is what the operator sees while it is pending,
 * and it settles the gate with the verdict. The ceremony itself is
 * {@link StepUpPrompt}, the same component the terminal panel renders inline, so
 * there is exactly one state machine for the two refusal codes that move the
 * prompt between passkey and password.
 *
 * Modal rather than inline, and dismissible: unlike the terminal panel — where
 * the prompt IS the resting state of a surface the user deliberately opened —
 * this can appear over anything, including work the operator would rather finish
 * before proving anything. "Not now" settles the gate with `false`, and every
 * call waiting behind it rethrows the server's original refusal, which is what
 * the call sites that already understand it expect.
 */
interface Props {
  gate: StepUpGate
  connection: RemoteConnection
}

/**
 * What the user was doing, in their words. Derived from the channel whose
 * refusal opened the demand — copy only; the server refused for FRESHNESS,
 * which is a fact about the connection rather than the verb.
 */
function describeDemand(demand: StepUpDemand): string {
  if (demand.channel.startsWith('authcfg:')) return 'to change your remote-access settings'
  if (demand.channel.startsWith('terminal:')) return 'to use the terminal'
  if (demand.channel.startsWith('git:')) return 'to run that git action'
  return 'to continue'
}

export function StepUpOverlay({ gate, connection }: Props): React.JSX.Element | null {
  const [demand, setDemand] = useState<StepUpDemand | null>(null)

  useEffect(() => gate.subscribe(setDemand), [gate])

  if (!demand) return null
  const what = describeDemand(demand)

  return (
    <div
      data-testid="StepUpOverlay"
      data-channel={demand.channel}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9998] flex items-center justify-center px-4"
      style={{ background: 'rgba(13,17,23,0.85)' }}
    >
      <div className="w-full max-w-[420px] rounded-lg border border-border bg-bg-secondary py-6 shadow-xl">
        <StepUpPrompt
          testid="StepUpPrompt"
          // The connection's own answer, not a guess: it knows whether this
          // socket authenticated with a passkey and whether this origin
          // advertises one. The server still refuses what it does not accept,
          // and both refusal codes flip the prompt either way.
          passkey={connection.passkeyAvailable()}
          title="Confirm it's you"
          passkeyHint={`This server asks for a fresh check ${what}. Use your passkey — nothing leaves your device.`}
          passwordHint={`This server asks for a fresh check ${what}. Enter your remote-access password.`}
          onGranted={() => gate.settle(true)}
          onCancel={() => gate.settle(false)}
        />
      </div>
    </div>
  )
}
