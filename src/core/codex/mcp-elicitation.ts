import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams'

/**
 * Codex's MCP tool approval, as it actually reaches a client (Slice 4b).
 *
 * There is no `item/mcpToolCall/requestApproval` on this wire. Before an MCP
 * tool runs under a mode that asks, `core/src/mcp_tool_call.rs`
 * (`request_mcp_tool_user_approval`) builds a FORM ELICITATION and sends it as
 * the server request `mcpServer/elicitation/request`; the client's answer is
 * read back by `parse_mcp_tool_approval_elicitation_response`, which maps
 * anything but `accept` — including the `Method not found` an unregistered
 * method earns — to `ReviewDecision::denied("user rejected MCP tool call")`.
 *
 * What the form carries, read off `build_mcp_tool_approval_elicitation_request`
 * and `build_mcp_tool_approval_elicitation_meta` and confirmed against a
 * request captured from the pinned 0.154.0 binary
 * (`src/integration/codex/codex-mcp-approval.integration.test.ts`):
 *
 *  - `serverName` — the MCP server, on the params (app-server's own field).
 *  - `mode: "form"`, `message`, `requestedSchema` — the schema is literally
 *    `{ "type": "object", "properties": {} }` for an approval: the form asks
 *    for NO fields.
 *  - `_meta.codex_approval_kind === "mcp_tool_call"` — the discriminator
 *    (`protocol/src/mcp_approval_meta.rs`, `APPROVAL_KIND_KEY`, whose doc
 *    comment calls it what "identifies privileged Codex approvals").
 *  - `_meta.tool_params` — the arguments the model passed, verbatim.
 *  - `_meta.persist` — which of Codex's OWN persistence options the prompt
 *    offers. ClaudeUI never echoes it back: rules and session allows are
 *    ClaudeUI's (ADR-067), and the app-server DOES forward a response `_meta`
 *    into `Op::ResolveElicitation`, so sending it would really persist.
 *
 * Two things the form does NOT carry, both load-bearing:
 *
 *  - **The question id.** `request_mcp_tool_user_approval` mints
 *    `mcp_tool_call_approval_<id>` and uses it as the MCP-level REQUEST id;
 *    nothing puts it in the params, and the generated
 *    `McpServerElicitationRequestParams` has no field for it. So the accept
 *    content cannot be keyed by it — see {@link MCP_ELICITATION_ACCEPT}.
 *  - **The tool name**, for a plain (non-connector) server. The meta key
 *    `tool_name` exists in `mcp_approval_meta.rs` and connector-originated
 *    forms set it, but `build_mcp_tool_approval_elicitation_meta` does not.
 *    The name is only in the message, which for a plain server is exactly
 *    `build_mcp_tool_approval_fallback_message`'s
 *    `Allow the <server> MCP server to run tool "<tool>"?`.
 */

/** `APPROVAL_KIND_KEY` / `APPROVAL_KIND_MCP_TOOL_CALL` in `mcp_approval_meta.rs`. */
export const MCP_APPROVAL_KIND_KEY = 'codex_approval_kind'
export const MCP_APPROVAL_KIND_TOOL_CALL = 'mcp_tool_call'
/** `TOOL_NAME_KEY` / `TOOL_PARAMS_KEY` in the same module. */
export const MCP_APPROVAL_TOOL_NAME_KEY = 'tool_name'
export const MCP_APPROVAL_TOOL_PARAMS_KEY = 'tool_params'

/**
 * The accept body, and why it is empty rather than `{ <questionId>: "Allow" }`.
 *
 * `parse_mcp_tool_approval_elicitation_response` reads an `accept` in three
 * steps: a `_meta.persist` of `session`/`always` short-circuits to
 * `ApprovedForSession` / `ApprovedMcpPolicyAmendment` (never sent from here);
 * otherwise `request_user_input_response_from_elicitation_content` turns
 * `content` into an answer map — a MISSING content becomes an empty map, and so
 * does `{}` — and `parse_mcp_tool_approval_response` looks the question id up in
 * it, returning `Abort` when it is absent. That `Abort` is then mapped back to
 * `ReviewDecision::Approved` by the accept arm. So on this binary an accept with
 * no answers is a plain approval, which is exactly the one ClaudeUI wants: the
 * two answer strings that mean anything else ("Allow for this session", "Allow
 * and don't ask me again") are Codex's own persistence, which ClaudeUI owns
 * instead. The question id is not on the wire to key an explicit `"Allow"` by,
 * and keying it wrongly would land on this same path anyway.
 */
export const MCP_ELICITATION_ACCEPT = { action: 'accept', content: {} } as const
export const MCP_ELICITATION_DECLINE = { action: 'decline', content: null } as const

/** One MCP tool call awaiting ClaudeUI's verdict. */
export interface McpToolApproval {
  server: string
  /**
   * The tool, or null when the form does not name one (a connector template
   * replaced the message, say). The gate then scopes to the whole server, which
   * is a real Claude rule (`mcp__<server>`) and never widens a verdict: a
   * server-wide allow rule is the user's own, and with no rule the mode base
   * still asks.
   */
  tool: string | null
  /** The model's arguments, for display on the card. Never gated on. */
  params: Record<string, unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The Claude rule / session-allow vocabulary for one MCP tool:
 * `mcp__<server>__<tool>`, or `mcp__<server>` when the tool is unknown. Both
 * classify as kind `mcp` (`shared/tool-kinds.ts`) and both are matchable rule
 * strings (`pi/permission-engine.ts`).
 */
export function mcpRuleToolName(server: string, tool: string | null): string {
  return tool ? `mcp__${server}__${tool}` : `mcp__${server}`
}

/**
 * The tool name out of the fallback message, anchored on the server name the
 * PARAMS carry rather than matched with a greedy pattern — a tool whose name
 * contains quotes cannot then steal the capture, and a message a template wrote
 * simply fails to parse (→ server-wide scope) instead of yielding a wrong name.
 */
function toolFromMessage(server: string, message: string): string | null {
  const prefix = `Allow the ${server} MCP server to run tool "`
  const suffix = '"?'
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) return null
  const tool = message.slice(prefix.length, message.length - suffix.length)
  return tool.length > 0 && !tool.includes('"') ? tool : null
}

/**
 * Read one `mcpServer/elicitation/request` as an MCP TOOL APPROVAL, or null
 * when it is some other elicitation (a server asking the user a real question,
 * a URL or user-verification flow) — those are declined with a warning, because
 * rendering arbitrary elicitation forms is out of scope for this slice.
 *
 * The discriminator is the meta kind, not the message: the message is prose an
 * MCP server can influence, while `codex_approval_kind` is what the core's own
 * elicitation router treats as privileged.
 */
export function readMcpToolApproval(params: unknown): McpToolApproval | null {
  if (!record(params)) return null
  const value = params as Partial<McpServerElicitationRequestParams> & Record<string, unknown>
  if (value.mode !== 'form' || typeof value.serverName !== 'string') return null
  const meta = record(value._meta) ? value._meta : undefined
  if (meta?.[MCP_APPROVAL_KIND_KEY] !== MCP_APPROVAL_KIND_TOOL_CALL) return null
  const named = meta[MCP_APPROVAL_TOOL_NAME_KEY]
  const tool =
    typeof named === 'string' && named.length > 0
      ? named
      : typeof value.message === 'string'
        ? toolFromMessage(value.serverName, value.message)
        : null
  const declared = meta[MCP_APPROVAL_TOOL_PARAMS_KEY]
  return { server: value.serverName, tool, params: record(declared) ? declared : {} }
}
