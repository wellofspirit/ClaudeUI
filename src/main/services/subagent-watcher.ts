/**
 * Subagent JSONL file watcher — provides live streaming for in-process team agents.
 *
 * With the team-streaming patch, each teammate writes to a single stable JSONL file
 * named `agent-<name>--<team>.jsonl`. This watcher tails that file and emits IPC
 * events so the UI gets live updates. It also serves as the mechanism for loading
 * teammate history on session reload.
 *
 * Falls back to prompt-based file matching for unpatched SDK sessions.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ChatMessage, ContentBlock } from '../../shared/types'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

interface WatchedSubagent {
  toolUseId: string
  filePath: string
  watcher: fs.FSWatcher | null
  /** Byte offset of content already parsed */
  parsedBytes: number
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** Polling interval for when file doesn't exist yet */
  pollTimer: ReturnType<typeof setInterval> | null
}

const watched = new Map<string, WatchedSubagent>()

/**
 * Build the stable JSONL filename for a teammate (team-streaming patch format).
 * The patch sanitizes `name@team` → `name--team` for the agentId, producing
 * filenames like `agent-ts-advocate--lang-debate.jsonl`.
 */
function stableTeammateFilename(name: string, teamName: string): string {
  return `agent-${name}--${teamName}.jsonl`
}

/**
 * Try to find the teammate's JSONL file by stable filename (patched SDK),
 * then fall back to prompt-based search (unpatched SDK).
 */
function findSubagentFile(
  sessionId: string,
  projectKey: string,
  teammateName?: string,
  teammateTeamName?: string,
  prompt?: string
): string | null {
  const subagentDir = path.join(CLAUDE_PROJECTS_DIR, projectKey, sessionId, 'subagents')

  // Try stable filename first (team-streaming patch)
  if (teammateName && teammateTeamName) {
    const stableName = stableTeammateFilename(teammateName, teammateTeamName)
    const stablePath = path.join(subagentDir, stableName)
    if (fs.existsSync(stablePath)) return stablePath
  }

  // Fall back to prompt-based search (unpatched SDK or non-team subagents)
  if (prompt) {
    return findSubagentFileByPrompt(subagentDir, prompt)
  }

  return null
}

/**
 * Scan the subagents directory for a file matching the given prompt.
 * Used as fallback for unpatched SDK sessions.
 */
function findSubagentFileByPrompt(subagentDir: string, prompt: string): string | null {
  if (!fs.existsSync(subagentDir)) return null

  const files = fs.readdirSync(subagentDir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .sort()

  const matchStr = prompt.slice(0, 80)

  // Walk backwards — most recent file is most likely the match
  for (let i = files.length - 1; i >= 0; i--) {
    const fname = files[i]
    try {
      const filePath = path.join(subagentDir, fname)
      const content = fs.readFileSync(filePath, 'utf-8')
      const firstNewline = content.indexOf('\n')
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content
      const obj = JSON.parse(firstLine)
      const msg = obj.message as Record<string, unknown> | undefined
      if (!msg) continue
      const msgContent = msg.content
      let text = ''
      if (typeof msgContent === 'string') {
        text = msgContent
      } else if (Array.isArray(msgContent)) {
        for (const b of msgContent) {
          if (typeof b === 'object' && b && 'text' in b) text += (b as Record<string, unknown>).text
        }
      }
      if (text && text.includes(matchStr)) {
        return filePath
      }
    } catch {
      // Skip malformed files
    }
  }
  return null
}

/**
 * Parse a single JSONL line into a ChatMessage (or null if not displayable).
 */
function parseJsonlLine(line: string): ChatMessage | null {
  try {
    const obj = JSON.parse(line)
    const type = obj.type as string

    if (type === 'user') {
      const content = obj.message?.content
      if (!content) return null
      const userType = obj.userType as string | undefined
      const isArray = Array.isArray(content)

      // Only show external user messages (typed prompts), not synthetic tool results
      if (userType === 'external') {
        let text = ''
        if (typeof content === 'string') {
          text = content
        } else if (isArray) {
          const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
          if (textBlock) text = textBlock.text as string
        }
        if (text) {
          return {
            id: obj.uuid || `user-${Date.now()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
          }
        }
      }

      // Tool results — return as-is so the UI can attach them
      if (isArray) {
        const toolResults: ContentBlock[] = []
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            let resultText = ''
            if (typeof block.content === 'string') {
              resultText = block.content
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .map((c: Record<string, unknown>) => (c.text as string) || '')
                .join('\n')
            }
            toolResults.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              toolResult: resultText,
              isError: !!block.is_error
            })
          }
        }
        if (toolResults.length > 0) {
          return {
            id: obj.uuid || `tool-result-${Date.now()}`,
            role: 'user',
            content: toolResults,
            timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
          }
        }
      }

      return null
    }

    if (type === 'assistant') {
      const betaMessage = obj.message as Record<string, unknown> | undefined
      if (!betaMessage?.content || !Array.isArray(betaMessage.content)) return null

      const blocks: ContentBlock[] = (betaMessage.content as Array<Record<string, unknown>>).map(
        (block) => {
          const blockType = block.type as string
          if (blockType === 'text') return { type: 'text' as const, text: block.text as string }
          if (blockType === 'tool_use') {
            return {
              type: 'tool_use' as const,
              toolName: block.name as string,
              toolInput: block.input as Record<string, unknown>,
              toolUseId: block.id as string
            }
          }
          if (blockType === 'tool_result') {
            const rc = block.content
            let text = ''
            if (typeof rc === 'string') text = rc
            else if (Array.isArray(rc))
              text = rc.map((c: Record<string, unknown>) => (c.text as string) || '').join('\n')
            return {
              type: 'tool_result' as const,
              toolUseId: block.tool_use_id as string,
              toolResult: text,
              isError: block.is_error as boolean
            }
          }
          if (blockType === 'thinking') return { type: 'thinking' as const, text: block.thinking as string }
          return { type: 'text' as const, text: JSON.stringify(block) }
        }
      )

      const messageId =
        (betaMessage.id as string) || (obj.uuid as string) || `assistant-${Date.now()}`
      return {
        id: messageId,
        role: 'assistant',
        content: blocks,
        timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Read new bytes from a file starting at the given offset, parse lines, return messages.
 */
function readNewMessages(
  filePath: string,
  fromByte: number
): { messages: ChatMessage[]; newOffset: number } {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= fromByte) return { messages: [], newOffset: fromByte }

    const fd = fs.openSync(filePath, 'r')
    try {
      const size = stat.size - fromByte
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, fromByte)
      const chunk = buf.toString('utf-8')

      const messages: ChatMessage[] = []
      const lines = chunk.split('\n')

      // If the last "line" is incomplete (no trailing newline), don't parse it yet.
      // We'll pick it up on the next read.
      let bytesConsumed = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Account for the newline separator (except possibly the last segment)
        const lineBytes = Buffer.byteLength(line, 'utf-8') + (i < lines.length - 1 ? 1 : 0)

        if (i === lines.length - 1 && !chunk.endsWith('\n')) {
          // Incomplete last line — don't consume it
          break
        }

        bytesConsumed += lineBytes
        if (!line.trim()) continue

        const msg = parseJsonlLine(line)
        if (msg) messages.push(msg)
      }

      return { messages, newOffset: fromByte + bytesConsumed }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { messages: [], newOffset: fromByte }
  }
}

/**
 * Start watching a subagent JSONL file for a detected teammate.
 *
 * @param toolUseId - The tool_use ID that launched this teammate
 * @param sessionId - The session ID
 * @param projectKey - The project key (cwd with slashes replaced)
 * @param prompt - The task prompt (fallback for finding the JSONL file by content matching)
 * @param sendFn - Function to send IPC events to the renderer
 * @param teammateName - The teammate's name (e.g., "ts-advocate")
 * @param teammateTeamName - The team name (e.g., "lang-debate")
 */
export function watchSubagent(
  toolUseId: string,
  sessionId: string,
  projectKey: string,
  prompt: string | undefined,
  sendFn: (channel: string, data: unknown) => void,
  teammateName?: string,
  teammateTeamName?: string
): void {
  // Already watching this toolUseId
  if (watched.has(toolUseId)) return

  const entry: WatchedSubagent = {
    toolUseId,
    filePath: '',
    watcher: null,
    parsedBytes: 0,
    debounceTimer: null,
    pollTimer: null
  }
  watched.set(toolUseId, entry)

  const startWatching = (filePath: string): void => {
    entry.filePath = filePath

    // Clear poll timer if we were polling for the file to appear
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer)
      entry.pollTimer = null
    }

    // Do an initial read of everything already in the file
    const { messages, newOffset } = readNewMessages(filePath, 0)
    entry.parsedBytes = newOffset
    if (messages.length > 0) {
      sendFn('session:subagent-message-batch', { toolUseId, messages })
    }

    // Watch for further changes
    try {
      entry.watcher = fs.watch(filePath, () => {
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.debounceTimer = setTimeout(() => {
          const { messages: newMsgs, newOffset: updatedOffset } = readNewMessages(
            filePath,
            entry.parsedBytes
          )
          entry.parsedBytes = updatedOffset
          if (newMsgs.length > 0) {
            sendFn('session:subagent-message-batch', { toolUseId, messages: newMsgs })
          }
        }, 150)
      })
    } catch {
      // File may have been removed — ignore
    }
  }

  // Try to find the file immediately (stable name first, then prompt fallback)
  const filePath = findSubagentFile(sessionId, projectKey, teammateName, teammateTeamName, prompt)
  if (filePath) {
    startWatching(filePath)
    return
  }

  // File doesn't exist yet — poll until it appears.
  // Team agents take a moment to spin up and create their JSONL files.
  let attempts = 0
  const MAX_ATTEMPTS = 60 // 30 seconds at 500ms intervals

  entry.pollTimer = setInterval(() => {
    attempts++
    if (attempts > MAX_ATTEMPTS) {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer)
        entry.pollTimer = null
      }
      return
    }

    const foundPath = findSubagentFile(sessionId, projectKey, teammateName, teammateTeamName, prompt)
    if (foundPath) {
      startWatching(foundPath)
    }
  }, 500)
}

/**
 * Stop watching a specific subagent.
 */
export function unwatchSubagent(toolUseId: string): void {
  const entry = watched.get(toolUseId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  if (entry.pollTimer) clearInterval(entry.pollTimer)
  if (entry.watcher) entry.watcher.close()
  watched.delete(toolUseId)
}

/**
 * Stop watching all subagents (called on session cleanup).
 */
export function unwatchAllSubagents(): void {
  for (const [toolUseId] of watched) {
    unwatchSubagent(toolUseId)
  }
}
