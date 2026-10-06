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
 *   [question]  `question` tool call (one single-choice question)
 *   [sub]       `subagent` tool call
 *   [slow]      many text chunks, `slowChunkMs` apart (steer / interrupt window)
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
  const streamToolCall = async (res: ServerResponse, name: string | undefined, args: object) => {
    // Answer in text rather than failing: a 5xx would make opencode retry and blur the trace.
    if (!name) return streamText(res, `FIXTURE_NO_TOOL for ${JSON.stringify(args)}`)
    chunk(res, { role: 'assistant', content: null })
    chunk(res, {
      tool_calls: [
        { index: 0, id: `call_fx_${n}`, type: 'function', function: { name, arguments: '' } }
      ]
    })
    chunk(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
    finishStream(res, 'tool_calls')
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
