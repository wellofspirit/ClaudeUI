// A local (stdio) MCP server for the opencode 2.x contract suite: one tool,
// `echo`, and a JSONL log of every `tools/call` (params incl. `_meta`) at
// $MCP_CALL_LOG. Newline-delimited JSON-RPC, as the MCP stdio transport speaks.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.MCP_CALL_LOG
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return // notifications
  switch (message.method) {
    case 'initialize':
      return send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'contract-fixture', version: '0.0.0' }
        }
      })
    case 'tools/list':
      return send({
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the text back',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text']
              }
            }
          ]
        }
      })
    case 'tools/call':
      if (LOG) appendFileSync(LOG, JSON.stringify(message.params) + '\n')
      return send({
        id: message.id,
        result: { content: [{ type: 'text', text: `echoed:${message.params?.arguments?.text}` }] }
      })
    default:
      return send({ id: message.id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
