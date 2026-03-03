#!/usr/bin/env node
/**
 * Minimal stdio MCP server for patch testing.
 *
 * Provides one tool: `patch_test_echo` — takes { text: string } and echoes it back.
 * Speaks JSON-RPC 2.0 over stdio (the MCP transport protocol).
 *
 * Usage: node patch/mcp-test-server.mjs
 */

import { createInterface } from 'node:readline'

const SERVER_INFO = {
  name: 'patch-test-server',
  version: '1.0.0',
}

const TOOLS = [
  {
    name: 'patch_test_echo',
    description: 'Echo the input text back. Used for testing MCP tool connectivity.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back' },
      },
      required: ['text'],
    },
  },
]

function handleRequest(req) {
  const { method, params, id } = req

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      }

    case 'notifications/initialized':
      // No response needed for notifications
      return null

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      }

    case 'tools/call': {
      const toolName = params?.name
      const args = params?.arguments || {}

      if (toolName === 'patch_test_echo') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: args.text || '(no text provided)' }],
          },
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      }
    }

    default:
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }
      }
      // Ignore unknown notifications
      return null
  }
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    const response = handleRequest(req)
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n')
    }
  } catch {
    // Ignore parse errors
  }
})

// Keep process alive
process.stdin.resume()
