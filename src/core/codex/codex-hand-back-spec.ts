/**
 * The dynamic tools a Codex dispatch TARGET is started with (ADR-105 §3, §4): `hand_back`,
 * the report that ends its run, and `session_message`. A leaf (types, shared strings and the
 * session tools' own schema module, which imports nothing of the services) because the
 * dispatcher builds the `thread/start` params and may not import the hosted-tools module
 * behind `CODEX_HOSTED_TOOL_NAMES` (that set is the ROOT session's security boundary, and
 * `hand_back` must not be in it: a root session has nobody to hand a report to).
 *
 * Same shape as the specs in `codex-hosted-tools.ts`: the canonical tagged form, a name
 * matching `^[a-zA-Z0-9_-]+$` that does not start with `mcp`.
 */
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import {
  HAND_BACK_DESCRIPTION,
  HAND_BACK_REPORT_PARAM,
  HAND_BACK_TOOL
} from '../../shared/dispatch-agent-description'
import { X_AGENT_MESSAGE_TOOL } from '../../shared/x-agent-message'
import { xAgentSessionMessageSpec } from '../services/session-tool-specs'

export function codexHandBackSpec(): DynamicToolSpec {
  return {
    type: 'function',
    name: HAND_BACK_TOOL,
    description: HAND_BACK_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        report: { type: 'string', description: HAND_BACK_REPORT_PARAM }
      },
      required: ['report'],
      additionalProperties: false
    }
  }
}

/**
 * The second tool a Codex dispatch TARGET is started with (ADR-105 §4): `session_message`, worded
 * for an X-Agent, which reaches the session that dispatched it and no other. Same leaf rule as
 * {@link codexHandBackSpec}: not in `CODEX_HOSTED_TOOL_NAMES`, the root session's boundary.
 */
export function codexXAgentMessageSpec(): DynamicToolSpec {
  const { description, parameters } = xAgentSessionMessageSpec()
  return {
    type: 'function',
    name: X_AGENT_MESSAGE_TOOL,
    description,
    inputSchema: parameters as JsonValue
  }
}
