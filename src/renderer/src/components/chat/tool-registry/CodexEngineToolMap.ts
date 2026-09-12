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
    if (name === 'render_mermaid') return 'diagram'
    if (name === 'create_mockup' || name === 'show_mockup') return 'mockup'
    // Cross-engine dispatch (ADR-033, slice E) — the engine-neutral TaskCard
    // kind, exactly as pi's identically-named bare tool takes.
    if (name === 'dispatch_agent') return 'task'
    // Native children (ADR-066 slice F): the spawn call is the card the child's
    // transcript hangs off, which is exactly what the shared TaskCard renders.
    if (name === 'collab:spawnAgent') return 'task'
    return 'unknown'
  },
  displayName(name) {
    return (
      {
        commandExecution: 'Command',
        fileChange: 'File changes',
        requestUserInput: 'Question',
        ...HOSTED_DISPLAY_NAMES,
        ...COLLAB_DISPLAY_NAMES
      }[name] ?? name
    )
  },
  normalize(kind, input, result) {
    if (kind === 'command')
      return { kind, command: String(input?.command ?? ''), output: result?.toolResult }
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
    return { kind: 'unknown', input }
  }
}
