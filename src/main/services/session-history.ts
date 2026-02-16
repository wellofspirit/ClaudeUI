import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { ChatMessage, ContentBlock, DirectoryGroup, SessionInfo, TaskNotification, StatusLineData } from '../../shared/types'
import { getCachedSummary } from './session-summary-cache'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/**
 * Scan ~/.claude/projects/ for session directories and build DirectoryGroup[].
 * For each JSONL, reads the first ~20 lines to extract the title (first user prompt)
 * and uses file mtime for lastActivityAt.
 */
export async function listDirectories(): Promise<DirectoryGroup[]> {
  let projectDirs: string[]
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((name) => {
      const full = path.join(CLAUDE_PROJECTS_DIR, name)
      return fs.statSync(full).isDirectory()
    })
  } catch {
    return []
  }

  const groups: DirectoryGroup[] = []

  for (const projectKey of projectDirs) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey)
    let jsonlFiles: string[]
    try {
      jsonlFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    if (jsonlFiles.length === 0) continue

    const sessions: SessionInfo[] = []
    let groupCwd = ''

    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '')
      const filePath = path.join(projectDir, file)

      let mtime: number
      try {
        mtime = fs.statSync(filePath).mtimeMs
      } catch {
        continue
      }

      const info = await parseSessionHeader(filePath, sessionId, projectKey)
      if (!info) continue

      if (!groupCwd && info.cwd) groupCwd = info.cwd

      // Priority: custom-title from JSONL > cached summary > first user prompt
      const customTitle = readLastCustomTitle(filePath)
      const summary = getCachedSummary(filePath, mtime)

      sessions.push({
        sessionId,
        cwd: info.cwd || '',
        projectKey,
        title: customTitle || summary || info.title || 'Untitled',
        timestamp: info.timestamp || mtime,
        lastActivityAt: mtime
      })
    }

    if (sessions.length === 0) continue

    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)

    // Derive folder name from cwd or projectKey
    const folderName = groupCwd
      ? groupCwd.split(/[\\/]/).pop() || groupCwd
      : projectKey

    groups.push({
      cwd: groupCwd,
      projectKey,
      folderName,
      sessions
    })
  }

  // Sort groups by most recent session activity
  groups.sort((a, b) => {
    const aMax = a.sessions[0]?.lastActivityAt || 0
    const bMax = b.sessions[0]?.lastActivityAt || 0
    return bMax - aMax
  })

  return groups
}

interface SessionHeader {
  title: string
  timestamp: number
  cwd: string
}

/**
 * Read the first ~20 lines of a JSONL to extract title, timestamp, cwd
 * from the first external user message.
 */
async function parseSessionHeader(
  filePath: string,
  _sessionId: string,
  _projectKey: string
): Promise<SessionHeader | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream })
    let lineCount = 0
    let result: SessionHeader | null = null

    rl.on('line', (line) => {
      lineCount++
      if (lineCount > 30) {
        rl.close()
        stream.destroy()
        return
      }

      try {
        const obj = JSON.parse(line)

        // Look for external user messages
        if (
          obj.type === 'user' &&
          obj.userType === 'external' &&
          obj.message?.content
        ) {
          const content = obj.message.content
          let text = ''
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textBlock = content.find(
              (b: Record<string, unknown>) => b.type === 'text'
            )
            if (textBlock) text = textBlock.text as string
          }

          if (text && !result) {
            result = {
              title: text.slice(0, 80).replace(/\n/g, ' ').trim(),
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
              cwd: obj.cwd || ''
            }
            rl.close()
            stream.destroy()
          }
        }
      } catch {
        // Skip malformed lines
      }
    })

    rl.on('close', () => resolve(result))
    rl.on('error', () => resolve(null))
  })
}

/**
 * Read the last custom-title entry from a JSONL file.
 * Scans the tail of the file (last 8KB) for efficiency since titles are appended.
 */
function readLastCustomTitle(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    const readSize = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(readSize)
    const fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
    fs.closeSync(fd)

    const tail = buf.toString('utf-8')
    let lastTitle: string | null = null
    for (const line of tail.split('\n')) {
      if (!line.includes('"custom-title"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
          lastTitle = obj.customTitle
        }
      } catch {
        // partial line at start of buffer, skip
      }
    }
    return lastTitle
  } catch {
    return null
  }
}

export interface SessionHistoryResult {
  messages: ChatMessage[]
  taskNotifications: TaskNotification[]
  customTitle: string | null
  statusLine: StatusLineData | null
  /** Maps agentId → toolUseId for subagent JSONL lookup */
  agentIdToToolUseId: Record<string, string>
}

/**
 * Parse task-notification XML from JSONL content strings.
 * Returns null if no task notification found.
 */
function parseTaskNotificationXml(text: string): Omit<TaskNotification, 'toolUseId' | 'outputFile'> | null {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)
  if (!match) return null

  const xml = match[1]
  const get = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }

  const taskId = get('task-id')
  const status = get('status') as 'completed' | 'failed' | 'stopped'
  const summary = get('summary')

  // Parse usage block if present
  const usageStr = get('usage')
  let usage: TaskNotification['usage'] | undefined
  if (usageStr) {
    const getNum = (key: string): number => {
      const m = usageStr.match(new RegExp(`${key}:\\s*(\\d+)`))
      return m ? Number(m[1]) : 0
    }
    usage = {
      totalTokens: getNum('total_tokens'),
      toolUses: getNum('tool_uses'),
      durationMs: getNum('duration_ms')
    }
  }

  if (!taskId || !status) return null
  return { taskId, status, summary, usage }
}

/** Parse CLI command XML into structured data */
function parseCliCommand(text: string): { commandName: string; commandArgs?: string; commandOutput?: string } | null {
  // Format 1: <command-name>X</command-name><command-message>Y</command-message><command-args>Z</command-args>
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (nameMatch) {
    const commandName = nameMatch[1].trim()
    const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    return {
      commandName,
      commandArgs: argsMatch ? argsMatch[1].trim() : undefined
    }
  }
  // Format 2: <local-command-stdout>X</local-command-stdout> or <local-command-caveat>...
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
  const stderrMatch = text.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)
  if (stdoutMatch || stderrMatch) {
    const output = (stdoutMatch?.[1] || '') + (stderrMatch ? (stdoutMatch ? '\n' : '') + stderrMatch[1] : '')
    return {
      commandName: 'output',
      commandOutput: output.trim() || undefined
    }
  }
  // local-command-caveat — skip, just noise
  if (text.includes('<local-command-caveat>')) return null
  return null
}

/** Extract <output-file> path from task-notification XML */
function extractOutputFile(text: string): string {
  const m = text.match(/<output-file>([\s\S]*?)<\/output-file>/)
  return m ? m[1].trim() : ''
}

/**
 * Load full conversation history from a JSONL session file.
 * Converts SDK messages to ChatMessage[] and extracts TaskNotification[].
 */
export async function loadSessionHistory(
  sessionId: string,
  projectKey: string
): Promise<SessionHistoryResult> {
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)

  return new Promise((resolve) => {
    const messages: ChatMessage[] = []
    const taskNotifications: TaskNotification[] = []
    let customTitle: string | null = null
    // Map agentId (from task-notification <task-id>) → toolUseId (from Task tool_use)
    const agentIdToToolUseId: Record<string, string> = {}
    // Status line: prefer the last status_line event; fall back to JSONL file size
    let lastStatusLine: StatusLineData | null = null
    let fallbackCost = 0
    let fallbackDurationMs = 0

    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    } catch {
      resolve({ messages: [], taskNotifications: [], customTitle: null, agentIdToToolUseId: {}, statusLine: null })
      return
    }

    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line)
        const type = obj.type as string

        if (type === 'custom-title') {
          if (typeof obj.customTitle === 'string') customTitle = obj.customTitle
          return
        }

        if (type === 'user') {
          const content = obj.message?.content
          if (!content) return

          // Compact summary — attach text to the preceding compact_separator
          if (obj.isCompactSummary) {
            const text = typeof content === 'string' ? content : ''
            // Find the last compact_separator message and attach the summary
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i]
              if (m.role === 'system' && m.content[0]?.type === 'compact_separator') {
                messages[i] = { ...m, content: [{ type: 'compact_separator', text }] }
                break
              }
            }
            return
          }

          const userType = obj.userType as string | undefined
          const isArray = Array.isArray(content)
          const isString = typeof content === 'string'

          // String content — can be user prompt, task-notification, or command
          if (isString) {
            const text = content as string
            // Task notification
            const notif = parseTaskNotificationXml(text)
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({ ...notif, toolUseId, outputFile: extractOutputFile(text) })
              return
            }
            // CLI commands — parse and emit as cli_command block
            if (text.startsWith('<command-name>') || text.startsWith('<local-command')) {
              const cmd = parseCliCommand(text)
              if (cmd) {
                messages.push({
                  id: obj.uuid || `cmd-${messages.length}`,
                  role: 'system',
                  content: [{ type: 'cli_command', ...cmd }],
                  timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
                })
              }
              return
            }
            // Regular user prompt
            if (userType === 'external' && text.trim()) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                ...(obj.planContent ? { planContent: obj.planContent as string } : {})
              })
            }
            return
          }

          if (!isArray) return

          // Array content — check block types
          const hasTextBlock = content.some((b: Record<string, unknown>) => b.type === 'text')
          const hasToolResult = content.some((b: Record<string, unknown>) => b.type === 'tool_result')

          // External user prompt with text blocks
          if (userType === 'external' && hasTextBlock) {
            const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
            const text = textBlock ? (textBlock.text as string) : ''

            // Check if text is actually a task notification
            const notif = text ? parseTaskNotificationXml(text) : null
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({ ...notif, toolUseId, outputFile: extractOutputFile(text) })
            } else if (text && (text.startsWith('<command-name>') || text.startsWith('<local-command'))) {
              const cmd = parseCliCommand(text)
              if (cmd) {
                messages.push({
                  id: obj.uuid || `cmd-${messages.length}`,
                  role: 'system',
                  content: [{ type: 'cli_command', ...cmd }],
                  timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
                })
              }
            } else if (text) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
                ...(obj.planContent ? { planContent: obj.planContent as string } : {})
              })
            }
          }

          // Tool results — attach to preceding assistant message
          if (hasToolResult) {
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

                // Extract agentId from Task tool results for mapping
                const agentMatch = resultText.match(/agentId:\s*(\w+)/)
                if (agentMatch) {
                  agentIdToToolUseId[agentMatch[1]] = block.tool_use_id
                }

                // Find last assistant message with matching tool_use
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]
                  if (msg.role !== 'assistant') continue
                  const hasToolUse = msg.content.some(
                    (b) => b.type === 'tool_use' && b.toolUseId === block.tool_use_id
                  )
                  if (hasToolUse) {
                    messages[i] = {
                      ...msg,
                      content: [
                        ...msg.content,
                        {
                          type: 'tool_result',
                          toolUseId: block.tool_use_id,
                          toolResult: resultText,
                          isError: !!block.is_error
                        }
                      ]
                    }
                    break
                  }
                }
              }
            }
          }
        } else if (type === 'assistant') {
          // API error messages (rate_limit, invalid_request, etc.)
          if (obj.isApiErrorMessage || obj.error) {
            messages.push({
              id: obj.uuid || `error-${messages.length}`,
              role: 'system',
              content: [{
                type: 'api_error',
                errorType: (obj.error as string) || 'unknown',
                errorMessage: obj.message
                  ? typeof obj.message === 'string'
                    ? obj.message
                    : JSON.stringify(obj.message)
                  : (obj.error as string) || 'API error'
              }],
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            })
            return
          }

          const betaMessage = obj.message as Record<string, unknown> | undefined
          if (!betaMessage?.content || !Array.isArray(betaMessage.content)) return

          const blocks: ContentBlock[] = (betaMessage.content as Array<Record<string, unknown>>).map(
            (block) => {
              const blockType = block.type as string
              if (blockType === 'text') {
                return { type: 'text' as const, text: block.text as string }
              } else if (blockType === 'tool_use') {
                return {
                  type: 'tool_use' as const,
                  toolName: block.name as string,
                  toolInput: block.input as Record<string, unknown>,
                  toolUseId: block.id as string
                }
              } else if (blockType === 'tool_result') {
                const resultContent = block.content
                let text = ''
                if (typeof resultContent === 'string') {
                  text = resultContent
                } else if (Array.isArray(resultContent)) {
                  text = resultContent
                    .map((c: Record<string, unknown>) => (c.text as string) || '')
                    .join('\n')
                }
                return {
                  type: 'tool_result' as const,
                  toolUseId: block.tool_use_id as string,
                  toolResult: text,
                  isError: block.is_error as boolean
                }
              } else if (blockType === 'thinking') {
                return { type: 'thinking' as const, text: block.thinking as string }
              }
              return { type: 'text' as const, text: JSON.stringify(block) }
            }
          )

          const messageId =
            (betaMessage.id as string) || (obj.uuid as string) || `assistant-${messages.length}`

          // Upsert by ID (partial messages share the same betaMessage.id)
          const existingIdx = messages.findIndex((m) => m.id === messageId)
          const chatMsg: ChatMessage = {
            id: messageId,
            role: 'assistant',
            content: blocks,
            timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
          }

          if (existingIdx >= 0) {
            // Merge: preserve old blocks not present in the new update
            const oldBlocks = messages[existingIdx].content
            const newToolUseIds = new Set(blocks.filter(b => b.type === 'tool_use' && b.toolUseId).map(b => b.toolUseId))
            const newToolResultIds = new Set(blocks.filter(b => b.type === 'tool_result' && b.toolUseId).map(b => b.toolUseId))
            const newHasText = blocks.some(b => b.type === 'text')
            const newHasThinking = blocks.some(b => b.type === 'thinking')
            const preserved = oldBlocks.filter(b => {
              if (b.type === 'tool_use' && b.toolUseId && !newToolUseIds.has(b.toolUseId)) return true
              if (b.type === 'tool_result' && b.toolUseId && !newToolResultIds.has(b.toolUseId)) return true
              if (b.type === 'text' && !newHasText) return true
              if (b.type === 'thinking' && !newHasThinking) return true
              return false
            })
            messages[existingIdx] = { ...chatMsg, content: [...preserved, ...blocks] }
          } else {
            messages.push(chatMsg)
          }
        } else if (type === 'queue-operation') {
          // Task notifications can appear as queue-operation entries
          const content = obj.content as string | undefined
          if (content) {
            const notif = parseTaskNotificationXml(content)
            if (notif) {
              const toolUseId = agentIdToToolUseId[notif.taskId] || null
              taskNotifications.push({
                ...notif,
                toolUseId,
                outputFile: extractOutputFile(content)
              })
            }
          }
        } else if (type === 'result') {
          fallbackCost += (obj.total_cost_usd as number) || 0
          fallbackDurationMs += (obj.duration_ms as number) || 0
        } else if (type === 'system') {
          const subtype = obj.subtype as string | undefined
          if (subtype === 'compact_boundary') {
            messages.push({
              id: obj.uuid || `compact-${messages.length}`,
              role: 'system',
              content: [{ type: 'compact_separator' }],
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            })
          } else if (subtype === 'status_line') {
            const cost = obj.cost as Record<string, unknown> | undefined
            const ctxWindow = obj.context_window as Record<string, unknown> | undefined
            lastStatusLine = {
              totalCostUsd: (cost?.total_cost_usd as number) ?? 0,
              totalDurationMs: (cost?.total_duration_ms as number) ?? 0,
              totalApiDurationMs: (cost?.total_api_duration_ms as number) ?? 0,
              totalLinesAdded: (cost?.total_lines_added as number) ?? 0,
              totalLinesRemoved: (cost?.total_lines_removed as number) ?? 0,
              totalInputTokens: (ctxWindow?.total_input_tokens as number) ?? 0,
              totalOutputTokens: (ctxWindow?.total_output_tokens as number) ?? 0,
              contextWindowSize: (ctxWindow?.context_window_size as number) ?? 0,
              usedPercentage: (ctxWindow?.used_percentage as number) ?? null,
              remainingPercentage: (ctxWindow?.remaining_percentage as number) ?? null
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    })

    rl.on('close', () => {
      // Use the last status_line event if available; otherwise show JSONL file size
      let statusLine: StatusLineData | null = lastStatusLine
      if (!statusLine) {
        try {
          const fileSize = fs.statSync(filePath).size
          statusLine = {
            totalCostUsd: fallbackCost,
            totalDurationMs: fallbackDurationMs,
            totalApiDurationMs: 0,
            totalLinesAdded: 0,
            totalLinesRemoved: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            contextWindowSize: 0,
            usedPercentage: null,
            remainingPercentage: null,
            jsonlFileSize: fileSize
          }
        } catch {
          // Can't stat file — leave statusLine null
        }
      }
      resolve({ messages, taskNotifications, customTitle, agentIdToToolUseId, statusLine })
    })
    rl.on('error', () => resolve({ messages: [], taskNotifications: [], customTitle: null, agentIdToToolUseId: {}, statusLine: null }))
  })
}

/**
 * Load subagent conversation history from disk.
 * Subagent JSONL files are at: ~/.claude/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.jsonl
 */
export async function loadSubagentHistory(
  sessionId: string,
  projectKey: string,
  agentId: string
): Promise<ChatMessage[]> {
  const filePath = path.join(
    CLAUDE_PROJECTS_DIR,
    projectKey,
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`
  )

  if (!fs.existsSync(filePath)) return []
  return parseJsonlFile(filePath)
}

/**
 * Load background bash task output from /tmp.
 */
/**
 * Load background bash task output.
 * Tries outputFile (from task-notification) first, falls back to path interpolation.
 */
export function loadBackgroundOutput(
  projectKey: string,
  taskId: string,
  outputFile?: string
): { content: string | null; purged: boolean } {
  // Try the explicit output file path first (from task-notification XML)
  if (outputFile && fs.existsSync(outputFile)) {
    try {
      const content = fs.readFileSync(outputFile, 'utf-8')
      return { content, purged: false }
    } catch {
      // Fall through to interpolated path
    }
  }

  // Fallback: interpolate path
  const uid = process.getuid?.() ?? 0
  const outputPath = path.join('/private/tmp', `claude-${uid}`, projectKey, 'tasks', `${taskId}.output`)

  if (!fs.existsSync(outputPath)) {
    return { content: null, purged: true }
  }

  try {
    const content = fs.readFileSync(outputPath, 'utf-8')
    return { content, purged: false }
  } catch {
    return { content: null, purged: true }
  }
}

/**
 * Parse a JSONL file into ChatMessage[] (shared logic for main session and subagents).
 */
async function parseJsonlFile(filePath: string): Promise<ChatMessage[]> {
  return new Promise((resolve) => {
    const messages: ChatMessage[] = []

    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    } catch {
      resolve([])
      return
    }

    const rl = readline.createInterface({ input: stream })

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line)
        const type = obj.type as string

        if (type === 'user') {
          const content = obj.message?.content
          if (!content) return
          const userType = obj.userType as string | undefined
          const isArray = Array.isArray(content)
          const hasTextBlock = isArray
            ? content.some((b: Record<string, unknown>) => b.type === 'text')
            : typeof content === 'string'
          const hasToolResult = isArray && content.some((b: Record<string, unknown>) => b.type === 'tool_result')

          if (userType === 'external' && hasTextBlock) {
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (isArray) {
              const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text')
              if (textBlock) text = textBlock.text as string
            }
            if (text && !parseTaskNotificationXml(text)) {
              messages.push({
                id: obj.uuid || `user-${messages.length}`,
                role: 'user',
                content: [{ type: 'text', text }],
                timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
              })
            }
          }

          if (hasToolResult && isArray) {
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
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]
                  if (msg.role !== 'assistant') continue
                  if (msg.content.some((b) => b.type === 'tool_use' && b.toolUseId === block.tool_use_id)) {
                    messages[i] = {
                      ...msg,
                      content: [...msg.content, {
                        type: 'tool_result',
                        toolUseId: block.tool_use_id,
                        toolResult: resultText,
                        isError: !!block.is_error
                      }]
                    }
                    break
                  }
                }
              }
            }
          }
        } else if (type === 'assistant') {
          const betaMessage = obj.message as Record<string, unknown> | undefined
          if (!betaMessage?.content || !Array.isArray(betaMessage.content)) return

          const blocks: ContentBlock[] = (betaMessage.content as Array<Record<string, unknown>>).map(
            (block) => {
              const blockType = block.type as string
              if (blockType === 'text') return { type: 'text' as const, text: block.text as string }
              if (blockType === 'tool_use') return { type: 'tool_use' as const, toolName: block.name as string, toolInput: block.input as Record<string, unknown>, toolUseId: block.id as string }
              if (blockType === 'tool_result') {
                const rc = block.content
                let text = ''
                if (typeof rc === 'string') text = rc
                else if (Array.isArray(rc)) text = rc.map((c: Record<string, unknown>) => (c.text as string) || '').join('\n')
                return { type: 'tool_result' as const, toolUseId: block.tool_use_id as string, toolResult: text, isError: block.is_error as boolean }
              }
              if (blockType === 'thinking') return { type: 'thinking' as const, text: block.thinking as string }
              return { type: 'text' as const, text: JSON.stringify(block) }
            }
          )

          const messageId = (betaMessage.id as string) || (obj.uuid as string) || `assistant-${messages.length}`
          const existingIdx = messages.findIndex((m) => m.id === messageId)
          const chatMsg: ChatMessage = { id: messageId, role: 'assistant', content: blocks, timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now() }
          if (existingIdx >= 0) {
            const oldBlocks = messages[existingIdx].content
            const newToolUseIds = new Set(blocks.filter(b => b.type === 'tool_use' && b.toolUseId).map(b => b.toolUseId))
            const newToolResultIds = new Set(blocks.filter(b => b.type === 'tool_result' && b.toolUseId).map(b => b.toolUseId))
            const newHasText = blocks.some(b => b.type === 'text')
            const newHasThinking = blocks.some(b => b.type === 'thinking')
            const preserved = oldBlocks.filter(b => {
              if (b.type === 'tool_use' && b.toolUseId && !newToolUseIds.has(b.toolUseId)) return true
              if (b.type === 'tool_result' && b.toolUseId && !newToolResultIds.has(b.toolUseId)) return true
              if (b.type === 'text' && !newHasText) return true
              if (b.type === 'thinking' && !newHasThinking) return true
              return false
            })
            messages[existingIdx] = { ...chatMsg, content: [...preserved, ...blocks] }
          } else {
            messages.push(chatMsg)
          }
        }
      } catch {
        // Skip malformed lines
      }
    })

    rl.on('close', () => resolve(messages))
    rl.on('error', () => resolve([]))
  })
}
