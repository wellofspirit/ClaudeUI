/**
 * The one dynamic tool a Codex dispatch TARGET is started with (ADR-105 §3): `hand_back`,
 * the report that ends its run. A leaf (types and shared strings only) because the
 * dispatcher builds the `thread/start` params and may not import the hosted-tools module
 * behind `CODEX_HOSTED_TOOL_NAMES` (that set is the ROOT session's security boundary, and
 * `hand_back` must not be in it: a root session has nobody to hand a report to).
 *
 * Same shape as the specs in `codex-hosted-tools.ts`: the canonical tagged form, a name
 * matching `^[a-zA-Z0-9_-]+$` that does not start with `mcp`.
 */
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import {
  HAND_BACK_DESCRIPTION,
  HAND_BACK_REPORT_PARAM,
  HAND_BACK_TOOL
} from '../../shared/dispatch-agent-description'

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
