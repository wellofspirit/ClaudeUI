import type { EngineToolMap } from '../../../../../shared/tool-kinds'
import type { AskUserQuestion, FileDiff } from '../../../../../shared/types'

export const CodexEngineToolMap: EngineToolMap = {
  hidden: new Set(),
  kindOf(name) {
    if (name === 'commandExecution') return 'command'
    if (name === 'fileChange') return 'fileEdit'
    if (name === 'requestUserInput') return 'question'
    return 'unknown'
  },
  displayName(name) {
    return (
      { commandExecution: 'Command', fileChange: 'File changes', requestUserInput: 'Question' }[
        name
      ] ?? name
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
    return { kind: 'unknown', input }
  }
}
