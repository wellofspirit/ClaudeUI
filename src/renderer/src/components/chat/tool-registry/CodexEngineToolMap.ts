import type { EngineToolMap } from '../../../../../shared/tool-kinds'
import type { AskUserQuestion, ContentBlock, FileDiff } from '../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/**
 * ClaudeUI's own hosted tools reach Codex over the native dynamic-tool channel
 * (`thread/start`'s `dynamicTools` + the `item/tool/call` server request — see
 * src/core/codex/codex-hosted-tools.ts). The wire name is the BARE tool name,
 * the same three strings pi's `pi.registerTool()` registrations use, so
 * `hostedMcpKind` (which only matches `mcp__*`) never catches them and they
 * need explicit cases here — mirroring PiEngineToolMap's identical ones.
 */
const HOSTED_DISPLAY_NAMES: Record<string, string> = {
  render_mermaid: 'Mermaid',
  create_mockup: 'Mockup',
  show_mockup: 'Mockup',
  dispatch_agent: 'Dispatch'
}

/**
 * Codex's native collaboration surface (`multi_agent_v1`), mapped by the
 * PREFIXED wire name the event mapper emits. Only `spawnAgent` owns a subagent
 * transcript — the child's messages are streamed under that call's tool_use id
 * — so it is the only one that takes the `task` kind; the rest are agent
 * bookkeeping whose input/result the generic body already renders honestly.
 */
const COLLAB_DISPLAY_NAMES: Record<string, string> = {
  'collab:spawnAgent': 'Agent',
  'collab:sendInput': 'Message agent',
  'collab:sendMessage': 'Message agent',
  'collab:resumeAgent': 'Resume agent',
  'collab:wait': 'Wait for agents',
  'collab:closeAgent': 'Close agent',
  'collab:followupTask': 'Follow-up task',
  'collab:interruptAgent': 'Interrupt agent',
  'collab:listAgents': 'List agents'
}

/**
 * `create_mockup`'s INPUT carries no `directory` — it is minted by the handler
 * and only appears in the result text. Same extraction as Pi/Opencode's
 * identical helpers (each EngineToolMap file stays self-contained by
 * convention; no cross-imports between them).
 */
function extractMockupDirectory(result?: ToolResultBlock): string | undefined {
  if (!result?.toolResult) return undefined
  const match = result.toolResult.match(/Directory:\s*(\S+)/)
  return match ? match[1] : undefined
}

export const CodexEngineToolMap: EngineToolMap = {
  hidden: new Set(),
  kindOf(name) {
    if (name === 'commandExecution') return 'command'
    if (name === 'fileChange') return 'fileEdit'
    if (name === 'requestUserInput') return 'question'
    // The eleven history-mapper kinds (F20). `imageView` takes the READ card —
    // the model looked at a file, and the core attaches its bytes, so the same
    // path header + thumbnail strip a Claude `Read` on a .png gets is right.
    if (name === 'webSearch') return 'web'
    if (name === 'imageView') return 'fileRead'
    if (name === 'imageGeneration') return 'image'
    if (name === 'sleep') return 'sleep'
    if (name === 'plan') return 'plan'
    if (name === 'render_mermaid') return 'diagram'
    if (name === 'create_mockup' || name === 'show_mockup') return 'mockup'
    // Cross-engine dispatch (ADR-033, slice E) — the engine-neutral TaskCard
    // kind, exactly as pi's identically-named bare tool takes.
    if (name === 'dispatch_agent') return 'task'
    // Native children (ADR-066 slice F): the spawn call is the card the child's
    // transcript hangs off, which is exactly what the shared TaskCard renders.
    if (name === 'collab:spawnAgent') return 'task'
    // An inherited MCP tool's approval card (Slice 4b) is named in Claude's rule
    // vocabulary, `mcp__<server>__<tool>`, so it takes the generic MCP kind the
    // other engines give the same shape (shared/tool-kinds.ts).
    if (name.startsWith('mcp__')) return 'mcp'
    return 'unknown'
  },
  displayName(name) {
    // An MCP call's header is the KIND, not the rule-vocabulary name: the server
    // and the tool are the card's summary line (`summary.ts`), so repeating
    // `mcp__<server>__<tool>` above them says it twice and reads as machinery.
    if (name.startsWith('mcp__')) return 'MCP'
    return (
      {
        commandExecution: 'Command',
        fileChange: 'File changes',
        requestUserInput: 'Question',
        webSearch: 'Web search',
        imageView: 'Read',
        imageGeneration: 'Image',
        sleep: 'Sleep',
        plan: 'Plan',
        ...HOSTED_DISPLAY_NAMES,
        ...COLLAB_DISPLAY_NAMES
      }[name] ?? name
    )
  },
  normalize(kind, input, result, toolName) {
    if (kind === 'command')
      return {
        kind,
        command: String(input?.command ?? ''),
        output: result?.toolResult,
        // Present only on a completed `commandExecution` (event-mapper.ts) —
        // `0` is a real value, so the guard tests the type, not truthiness.
        ...(typeof input?.exitCode === 'number' ? { exitCode: input.exitCode } : {})
      }
    if (kind === 'fileEdit')
      return {
        kind,
        path: '',
        before: '',
        after: '',
        files:
          result?.fileDiffs ??
          (Array.isArray(input?.files) ? (input.files as FileDiff[]) : undefined)
      }
    if (kind === 'question')
      return { kind, questions: (input?.questions ?? []) as AskUserQuestion[] }
    // render_mermaid args: { source, title? } — identical field names on every
    // engine, which is what lets the shared kind bodies render them unchanged.
    if (kind === 'diagram')
      return {
        kind,
        source: input?.source != null ? String(input.source) : '',
        title: input?.title != null ? String(input.title) : undefined
      }
    if (kind === 'task') {
      // Two different tools share this kind on Codex, and `normalize` is not
      // given the tool name — so the INPUT discriminates. Only the native spawn
      // carries `receiverThreadIds` (the child thread ids); only a dispatch
      // carries `engine`.
      if (Array.isArray(input?.receiverThreadIds))
        return {
          kind,
          description: 'Agent',
          prompt: input?.prompt != null ? String(input.prompt) : '',
          // v1 spawn items carry the child's model and the prompt it was given;
          // a v2 `subAgentActivity` carries neither, only the agent's canonical
          // path (`/root/<task_name>`), which is then the only thing that tells
          // two sibling agents apart on the card header.
          ...(input?.model != null
            ? { subagent: String(input.model), model: String(input.model) }
            : input?.agentPath != null
              ? { subagent: String(input.agentPath) }
              : {})
        }
      // dispatch_agent args: { engine, prompt, model?, session_id? } — the same
      // field names on every engine, so this branch is Pi/Claude/Opencode's
      // dispatch normalizer verbatim.
      return {
        kind,
        description: `Dispatch: ${String(input?.engine ?? '')}`,
        prompt: input?.prompt != null ? String(input.prompt) : '',
        subagent:
          input?.model != null
            ? `${String(input?.engine ?? '')} · ${String(input.model)}`
            : String(input?.engine ?? '')
      }
    }
    // create_mockup args: { html, title? }; show_mockup args: { directory }.
    if (kind === 'mockup')
      return {
        kind,
        directory:
          input?.directory != null ? String(input.directory) : extractMockupDirectory(result),
        title: input?.title != null ? String(input.title) : undefined
      }
    if (kind === 'web') {
      // `action` is the wire's own tagged union, narrowed here to the four the
      // card knows. The v2 projection spells the tags in CAMEL case
      // (`protocol/v2/WebSearchAction.ts`: `search | openPage | findInPage |
      // other`) even though the core's Rust enum serialises snake_case; both
      // spellings are accepted so a future projection change cannot silently
      // demote every page fetch to `other`.
      const tag = record(input?.action) ? String(input.action.type ?? '') : ''
      const fetched = tag === 'openPage' || tag === 'open_page'
      const found = tag === 'findInPage' || tag === 'find_in_page'
      return {
        kind,
        // An `openPage`/`findInPage` item's `query` is the core's own rendering
        // of the action (the url, or `'pattern' in url`), so the url is the
        // truer target — and the query is the fallback when the wire omits it.
        target:
          fetched || found
            ? webString(input?.action, 'url') || String(input?.query ?? '')
            : String(input?.query ?? ''),
        action: tag === 'search' ? 'search' : fetched ? 'fetch' : found ? 'find' : 'other',
        ...(Array.isArray(input?.results)
          ? { results: input.results as { title: string; url: string; snippet?: string }[] }
          : {})
      }
    }
    if (kind === 'fileRead')
      // `imageView` is the only Codex item on this kind. The PICTURE rides the
      // shared tool-result image strip; the body shows the path with no text.
      return { kind, path: String(input?.path ?? ''), content: '' }
    if (kind === 'image')
      return {
        kind,
        ...(input?.prompt != null ? { prompt: String(input.prompt) } : {}),
        ...(input?.savedPath != null ? { savedPath: String(input.savedPath) } : {})
      }
    if (kind === 'sleep')
      return { kind, durationMs: typeof input?.durationMs === 'number' ? input.durationMs : 0 }
    if (kind === 'plan') return { kind, plan: String(input?.plan ?? '') }
    if (kind === 'mcp') {
      // `mcp__<server>__<tool>`, split on the FIRST `__` after the prefix: a
      // server name cannot contain `__` in Claude's rule vocabulary, but a tool
      // name can, so the remainder is the tool whole.
      const rest = toolName?.startsWith('mcp__') ? toolName.slice('mcp__'.length) : ''
      const cut = rest.indexOf('__')
      const server = cut < 0 ? rest : rest.slice(0, cut)
      const tool = cut < 0 ? '' : rest.slice(cut + 2)
      // The Codex mapper's envelope (`{ arguments, readOnlyHint? }`) — see
      // `mapCodexItem`'s `mcpToolCall` case. An input without it (nothing
      // produces one today) falls back to itself, so the card degrades to the
      // arguments dump rather than an empty body.
      const envelope = input && 'arguments' in input
      return {
        kind,
        input: envelope ? input.arguments : input,
        ...(server ? { server } : {}),
        ...(tool ? { tool } : {}),
        ...(typeof input?.readOnlyHint === 'boolean' ? { readOnly: input.readOnlyHint } : {})
      }
    }
    return { kind: 'unknown', input }
  }
}

/** A plain JSON object, told apart from an array and from null. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One string field of a nested record, or '' when it is missing or not a string. */
function webString(value: unknown, key: string): string {
  return record(value) && typeof value[key] === 'string' ? value[key] : ''
}
