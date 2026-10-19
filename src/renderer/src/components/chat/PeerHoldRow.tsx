/**
 * Claude Code holding a message another Claude session sent this one
 * (`system/peer_message_hold`, slice 1a).
 *
 * Presentational: the block says what cli.js did with the message and the row
 * says so in one sentence, in the register of the other engine rows (a left rule,
 * small text — no card). While it is `held` there is ONE action, "Allow messages
 * from other Claude sessions here", which the container wires to
 * `allowPeerMessages`; the row then updates in place as cli.js releases or drops
 * the message. Layout is flex-wrap with a 32px-high target and no viewport units,
 * so it holds at phone width inside the zoom (ADR-093).
 */
import type { ContentBlock } from '../../../../shared/types'

type PeerHold = Extract<ContentBlock, { type: 'peer_hold' }>

/** cli.js's `cause` in words; an unknown one is shown as it came. */
function causeText(cause: string | undefined): string {
  switch (cause) {
    case 'mode-mismatch':
      return 'the two sessions run in different permission modes'
    case 'no-mode-asserted':
      return 'this session runs without prompts and the sender did not state its mode'
    case 'explicit-setting':
      return 'a Claude Code setting holds messages from other sessions'
    case 'mode-unknown':
      return 'this session’s permission mode is not known yet'
    case 'invalid-setting':
      return 'a Claude Code setting about peer messages could not be read'
    default:
      return cause ?? 'Claude Code’s own check'
  }
}

export function peerHoldSentence(block: PeerHold): string {
  const from = block.fromName ? `Claude session “${block.fromName}”` : 'another Claude session'
  if (block.state === 'released') return `A message from ${from} was released to the model.`
  if (block.state === 'dropped')
    return `A message from ${from} was dropped${block.outcome ? ` (${block.outcome})` : ''}. The model never saw it.`
  return `A message from ${from} is held by Claude Code: ${causeText(block.cause)}. The model has not seen it.`
}

export function PeerHoldRow({
  block,
  onAllow,
  busy,
  error
}: {
  block: PeerHold
  /** Absent where there is nothing to call (a read-only transcript). */
  onAllow?: () => void
  busy?: boolean
  error?: string | null
}): React.JSX.Element {
  const held = block.state === 'held'
  const rule = held ? 'border-warning/60' : 'border-border'
  return (
    <div
      data-testid="PeerHoldRow"
      data-state={block.state}
      data-id={block.holdId}
      className={`border-l-2 ${rule} pl-3 py-0.5 animate-fade-in`}
    >
      <div
        data-testid="PeerHoldRow.sentence"
        className={`text-[12px] break-words ${held ? 'text-text-primary' : 'text-text-muted'}`}
      >
        {peerHoldSentence(block)}
      </div>
      {held && onAllow && (
        <div className="mt-1.5 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            data-testid="PeerHoldRow.allow"
            disabled={busy}
            onClick={onAllow}
            className="min-h-8 text-[12px] font-medium rounded-md px-2.5 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
          >
            Allow messages from other Claude sessions here
          </button>
          {error && (
            <span data-testid="PeerHoldRow.error" className="text-[11px] text-danger break-words">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
