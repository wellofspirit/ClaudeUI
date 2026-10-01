/**
 * Host-injected agent messages (ADR-088 S3): the payload ClaudeUI hands the
 * bridge's `cui-deliver` command, and the reading of the `custom` message pi
 * stores for it.
 *
 * THE MARKING RULE. A task notification or a `send_message` delivery is
 * agent-authored text that enters a pi session through ONE path: an RPC
 * `prompt` `/cui-deliver <base64 JSON>`, whose bridge handler calls
 * `pi.sendMessage({customType: PI_AGENT_MESSAGE_CUSTOM_TYPE, …})`. pi stores it
 * with role `custom` (a `custom_message` entry on disk), so ClaudeUI recognises
 * it ONLY by that role + our customType + `details` — never by its text. No
 * code parses `<task-notification>` or `<agent-message>` out of a pi message to
 * decide anything, and agent-authored text is never sent through
 * `PiSession.run()`, a plain-text `prompt`, `steer` or `follow_up` (those would
 * store it as the user's own turn and expand it as a skill/prompt template).
 */

import type { TaskTerminalStatus } from '../../shared/types'

/** The `customType` pi stores on every message ClaudeUI injects. */
export const PI_AGENT_MESSAGE_CUSTOM_TYPE = 'claudeui-agent-message'

/** The bridge command (pi-bridge-source.ts v10). */
export const PI_DELIVER_COMMAND = '/cui-deliver'

/** Every ClaudeUI bridge command starts with this (`/cui-deliver`, `/cui-plan-enter`, …). */
export const PI_RESERVED_COMMAND_PREFIX = '/cui-'

/**
 * Whether model-authored text would run one of ClaudeUI's bridge commands if
 * sent as a pi `prompt` (pi runs an extension command before anything else).
 * Every host path that sends such text as a child's prompt refuses it: an
 * `agent` prompt, a dispatch target's prompt (both through
 * `PiChildRunner.runTurn`) and, in S3b, a `send_message` (ADR-088 S3).
 */
export function isReservedPiCommandText(text: string): boolean {
  return text.trimStart().startsWith(PI_RESERVED_COMMAND_PREFIX)
}

export type PiAgentDeliveryKind = 'task-notification' | 'agent-message'

/** What the row and the history loader read back from `details` (never from the text). */
export interface PiAgentDeliveryDetails {
  agentId: string
  toolUseId: string
  status?: TaskTerminalStatus
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  summary?: string
  runIndex?: number
  from?: string
  fromId?: string
  to?: string
}

export interface PiAgentDelivery {
  v: 1
  /** Matched against the `custom` message's `details.deliveryId` to confirm delivery (the ack does not, P-S4). */
  deliveryId: string
  kind: PiAgentDeliveryKind
  /** The exact model-facing text. Never logged. */
  text: string
  /** true: start a turn when the session is idle; false: append (passive). A running turn is steered either way. */
  wake: boolean
  /** The row's UI line ("Agent "x" completed"). */
  title: string
  details: PiAgentDeliveryDetails
}

/** What the bridge writes into the stored message's `details`. */
export type PiStoredDeliveryDetails = PiAgentDeliveryDetails & {
  v: 1
  kind: PiAgentDeliveryKind
  deliveryId: string
  title: string
}

/** Standard base64 of the JSON payload, no line breaks. */
export function encodeDelivery(payload: PiAgentDelivery): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** The exact RPC `prompt` message that delivers `payload`. */
export function deliveryCommand(payload: PiAgentDelivery): string {
  return `${PI_DELIVER_COMMAND} ${encodeDelivery(payload)}`
}

/**
 * The stored `details` of one of OUR messages, or null. The customType AND the
 * shape decide; a look-alike text in any other message never does.
 */
export function piAgentDeliveryDetails(
  customType: unknown,
  details: unknown
): PiStoredDeliveryDetails | null {
  if (customType !== PI_AGENT_MESSAGE_CUSTOM_TYPE) return null
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const d = details as Record<string, unknown>
  if (d.v !== 1) return null
  if (d.kind !== 'task-notification' && d.kind !== 'agent-message') return null
  if (typeof d.deliveryId !== 'string') return null
  return d as unknown as PiStoredDeliveryDetails
}
