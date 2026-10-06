/**
 * Localhost model provider for the opencode 2.x contract suite: an
 * OpenAI-compatible `chat.completions` streamer, scripted by markers in the
 * last user message, plus a Responses-API answer under `/upstream/…` for
 * ChatGPT requests the redirect plugin rewrites. In-process; records every
 * request so tests can assert what the MODEL saw.
 *
 * Markers (last user text):
 *   [tool]      shell tool call; after the tool result, echo the result
 *   [mcp]       call the first tool named `*_echo`; then echo the result
 *   [dispatch]  call ClaudeUI's hosted `claudeui_dispatch_agent`; then echo the result
 *   [mockup]    call ClaudeUI's hosted `claudeui_create_mockup`; then echo the result
 *   [question]  `question` tool call (one single-choice question)
 *   [sub]       `subagent` tool call
 *   [subread]   `subagent` tool call whose child prompt is `[read]`
 *   [subresume] `subagent` call RESUMING the last child named in the conversation
 *               (`sessionID="ses_…"` of an earlier result); its prompt is `[read]` too
 *   [reason]    `reasoning_content` deltas, then text
 *   [read]      `read` of `notes.txt`
 *   [edit]      `edit` of `notes.txt` (alpha → beta)
 *   [write]     `write` of `new.txt`
 *   [patch]     `patch` updating `notes.txt` (falls back to text when not offered)
 *   [multi]     ONE response with two calls: `read` of `notes.txt` and `write` of `multi.txt`
 *   [slow]      many text chunks, `slowChunkMs` apart (steer / interrupt window)
 *   a compaction request ("summarize the conversation") gets a summary that
 *               fills opencode's template (`COMPACTION_SUMMARY`)
 *   otherwise   "echo: <text>"
 * A request without tools (title generation) gets "Fixture title".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ChatMessage {
  readonly role: string
  readonly content: unknown
  readonly tool_call_id?: string
}

export interface ChatRequest {
  readonly n: number
  readonly path: string
  /** The Authorization header, or `null`. */
  readonly authorization: string | null
  readonly tools: readonly string[]
  readonly messages: readonly ChatMessage[]
  readonly lastUserText: string
}

export interface UpstreamRequest {
  readonly n: number
  readonly path: string
  readonly authorization: string | null
  readonly account: string | null
}

export interface FixtureProvider {
  readonly port: number
  readonly baseURL: string
  readonly origin: string
  readonly requests: ChatRequest[]
  readonly upstream: UpstreamRequest[]
  /**
   * Agent-loop requests (tools offered) whose messages mention `needle`;
   * prompts carry a nonce. Title-generation side requests are excluded.
   */
  mentioning(needle: string): ChatRequest[]
  close(): Promise<void>
}

export const SLOW_CHUNKS = 30
export const SHELL_COMMAND = 'echo contract-tool-ran'
export const REASONING_TEXT = 'thinking it over'
/** opencode accepts a summary carrying one of its template headings (core/src/session/compaction.ts). */
export const COMPACTION_SUMMARY = '## Objective\nContract compaction summary.'
/** The file the file-tool markers work on (a test creates it with `alpha`). */
export const NOTES_FILE = 'notes.txt'

const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part: { type?: string; text?: string }) => (part?.type === 'text' ? part.text : ''))
      .join('\n')
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'user') return messageText(messages[i].content)
  return ''
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

export async function startFixtureProvider(
  options: { slowChunkMs?: number } = {}
): Promise<FixtureProvider> {
  const slowChunkMs = options.slowChunkMs ?? 100
  const requests: ChatRequest[] = []
  const upstream: UpstreamRequest[] = []
  let n = 0

  const chunk = (
    res: ServerResponse,
    delta: object,
    finish: string | null = null,
    usage?: object
  ) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-fx',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {})
      })}\n\n`
    )
  const finishStream = (res: ServerResponse, reason: string) => {
    chunk(res, {}, reason)
    chunk(res, {}, null, USAGE)
    res.end('data: [DONE]\n\n')
  }
  const streamText = async (res: ServerResponse, text: string, pieces = 1) => {
    chunk(res, { role: 'assistant', content: '' })
    if (pieces === 1) chunk(res, { content: text })
    else
      for (let i = 0; i < pieces; i++) {
        // An interrupt closes the connection: stop writing into it.
        if (res.destroyed || res.writableEnded) return
        chunk(res, { content: `${text}#${i} ` })
        await sleep(slowChunkMs)
      }
    if (!res.destroyed) finishStream(res, 'stop')
  }
  const streamToolCall = async (res: ServerResponse, name: string | undefined, args: object) =>
    streamToolCalls(res, [{ name, args }])
  const streamToolCalls = async (
    res: ServerResponse,
    calls: readonly { name: string | undefined; args: object }[]
  ) => {
    // Answer in text rather than failing: a 5xx would make opencode retry and blur the trace.
    const missing = calls.find((call) => !call.name)
    if (missing) return streamText(res, `FIXTURE_NO_TOOL for ${JSON.stringify(missing.args)}`)
    chunk(res, { role: 'assistant', content: null })
    calls.forEach(({ name, args }, index) => {
      chunk(res, {
        tool_calls: [
          {
            index,
            id: `call_fx_${n}_${index}`,
            type: 'function',
            function: { name, arguments: '' }
          }
        ]
      })
      chunk(res, { tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }] })
    })
    finishStream(res, 'tool_calls')
  }
  const streamReasoning = async (res: ServerResponse, reasoning: string, text: string) => {
    chunk(res, { role: 'assistant', content: '' })
    for (const piece of reasoning.split(' ')) chunk(res, { reasoning_content: `${piece} ` })
    chunk(res, { content: text })
    finishStream(res, 'stop')
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const path = req.url ?? '/'
      const authorization = req.headers.authorization ?? null
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }))
        return
      }
      n++
      if (path.startsWith('/upstream/')) {
        const account = req.headers['chatgpt-account-id']
        upstream.push({
          n,
          path,
          authorization,
          account: typeof account === 'string' ? account : null
        })
        respondResponsesApi(res)
        return
      }
      let body: { messages?: ChatMessage[]; tools?: { function?: { name?: string } }[] } = {}
      try {
        body = JSON.parse(raw)
      } catch {
        // recorded with no messages
      }
      const messages = body.messages ?? []
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? '')
      const text = lastUserText(messages)
      requests.push({ n, path, authorization, tools, messages, lastUserText: text })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const last = messages.at(-1)
      if (tools.length === 0) return streamText(res, 'Fixture title')
      if (text.includes('summarize the conversation')) return streamText(res, COMPACTION_SUMMARY)
      if (last?.role === 'tool')
        return streamText(res, `TOOL_RESULT_SEEN: ${messageText(last.content).slice(0, 600)}`)
      if (text.includes('[tool]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'shell'),
          {
            command: SHELL_COMMAND,
            description: 'contract echo'
          }
        )
      if (text.includes('[mcp]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool.endsWith('_echo')),
          {
            text: 'hello-from-model'
          }
        )
      if (text.includes('[dispatch]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'claudeui_dispatch_agent'),
          { engine: 'claude', prompt: 'contract dispatch' }
        )
      if (text.includes('[mockup]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'claudeui_create_mockup'),
          { html: '<p>contract mockup</p>', title: 'Contract' }
        )
      if (text.includes('[question]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'question'),
          {
            questions: [
              {
                question: 'Pick a fruit?',
                header: 'Fruit',
                options: [
                  { label: 'Apple', description: 'red' },
                  { label: 'Banana', description: 'yellow' }
                ]
              }
            ]
          }
        )
      if (text.includes('[subresume]')) {
        const named = messages
          .map((message) => messageText(message.content))
          .join('\n')
          .match(/sessionID="(ses_[A-Za-z0-9]+)"/g)
        const sessionID = named?.at(-1)?.slice('sessionID="'.length, -1)
        return streamToolCall(
          res,
          sessionID ? tools.find((tool) => tool === 'subagent') : undefined,
          {
            description: 'contract reader again',
            prompt: 'child reads again [read]',
            agent: 'general',
            ...(sessionID ? { sessionID } : {})
          }
        )
      }
      if (text.includes('[subread]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'subagent'),
          {
            description: 'contract reader',
            prompt: 'child reads [read]',
            agent: 'general'
          }
        )
      if (text.includes('[reason]'))
        return streamReasoning(res, REASONING_TEXT, `reasoned: ${text.slice(0, 80)}`)
      if (text.includes('[read]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'read'),
          { path: NOTES_FILE }
        )
      if (text.includes('[edit]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'edit'),
          { path: NOTES_FILE, oldString: 'alpha', newString: 'beta' }
        )
      if (text.includes('[write]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'write'),
          { path: 'new.txt', content: 'hello from write\n' }
        )
      if (text.includes('[patch]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'patch'),
          {
            patchText: `*** Begin Patch\n*** Update File: ${NOTES_FILE}\n@@\n-beta\n+gamma\n*** End Patch`
          }
        )
      if (text.includes('[multi]'))
        return streamToolCalls(res, [
          { name: tools.find((tool) => tool === 'read'), args: { path: NOTES_FILE } },
          {
            name: tools.find((tool) => tool === 'write'),
            args: { path: 'multi.txt', content: 'two calls\n' }
          }
        ])
      if (text.includes('[sub]'))
        return streamToolCall(
          res,
          tools.find((tool) => tool === 'subagent'),
          {
            description: 'contract child',
            prompt: 'child says hi',
            agent: 'general'
          }
        )
      if (text.includes('[slow]')) return streamText(res, 'slow', SLOW_CHUNKS)
      return streamText(res, `echo: ${text.slice(0, 200)}`)
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    upstream,
    mentioning: (needle) =>
      requests.filter(
        (request) =>
          request.tools.length > 0 &&
          request.messages.some((message) => messageText(message.content).includes(needle))
      ),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** A minimal Responses-API SSE answer (what chatgpt.com/backend-api/codex/responses speaks). */
function respondResponsesApi(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const text = 'chatgpt fixture says hi'
  const item = {
    type: 'message',
    id: 'msg-fx',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  }
  const events = [
    { type: 'response.created', response: { id: 'resp-fx' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.content_part.added',
      item_id: 'msg-fx',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg-fx',
      output_index: 0,
      content_index: 0,
      delta: text
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp-fx', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    }
  ]
  res.end(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}
