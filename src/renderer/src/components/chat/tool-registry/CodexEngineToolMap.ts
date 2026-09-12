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
  show_mockup: 'Mockup'
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
    return 'unknown'
  },
  displayName(name) {
    return (
      {
        commandExecution: 'Command',
        fileChange: 'File changes',
        requestUserInput: 'Question',
        ...HOSTED_DISPLAY_NAMES
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
