/**
 * @vitest-environment node
 *
 * Unit tests for createOpencodeHostedToolsServer.
 *
 * Verifies:
 *   - Server is named 'claudeui' and carries all 3 tools
 *   - Mockup tool uses the provided cwd for file I/O
 *   - Tool names are exactly render_mermaid, create_mockup, show_mockup
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createOpencodeHostedToolsServer } from '../opencode-hosted-tools'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'claudeui-hosted-tools-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('createOpencodeHostedToolsServer', () => {
  it('returns a McpServer instance', () => {
    const server = createOpencodeHostedToolsServer(tmp)
    expect(server).toBeInstanceOf(McpServer)
  })

  it('registers exactly 3 tools: render_mermaid, create_mockup, show_mockup', () => {
    const server = createOpencodeHostedToolsServer(tmp)
    // Access the internal tool registry via the server's _registeredTools map
    // (internal API, but necessary for unit verification without a full MCP session).
    const toolNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}
    )
    expect(toolNames.sort()).toEqual(['create_mockup', 'render_mermaid', 'show_mockup'])
  })

  it('create_mockup writes files under <cwd>/.claude/ui/mockups', async () => {
    const server = createOpencodeHostedToolsServer(tmp)
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

    const result = (await tools['create_mockup'].handler({ html: '<h1>Hello</h1>' })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content[0].type).toBe('text')
    const text = result.content[0].text

    // Parse the directory ID from the result text.
    const m = /Directory:\s*(\S+)/.exec(text)
    expect(m).not.toBeNull()
    const id = m![1]

    const indexPath = join(tmp, '.claude', 'ui', 'mockups', id, 'index.html')
    expect(existsSync(indexPath)).toBe(true)

    const html = await readFile(indexPath, 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('https://cdn.tailwindcss.com')
  })

  it('show_mockup returns success text for an existing mockup', async () => {
    // Set up a pre-existing mockup directory.
    const id = 'abcd1234'
    const mockupDir = join(tmp, '.claude', 'ui', 'mockups', id)
    await mkdir(mockupDir, { recursive: true })
    await writeFile(join(mockupDir, 'index.html'), '<html></html>', 'utf-8')

    const server = createOpencodeHostedToolsServer(tmp)
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

    const result = (await tools['show_mockup'].handler({ directory: id })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content[0].text).toContain('Mockup displayed')
    expect(result.content[0].text).toContain(id)
  })

  it('cwd isolation: two servers for different cwds write to their own dirs', async () => {
    const tmp2 = await mkdtemp(join(tmpdir(), 'claudeui-hosted-tools-b-'))
    try {
      const serverA = createOpencodeHostedToolsServer(tmp)
      const serverB = createOpencodeHostedToolsServer(tmp2)
      const toolsA = (serverA as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools
      const toolsB = (serverB as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

      const resultA = (await toolsA['create_mockup'].handler({ html: '<p>A</p>' })) as { content: Array<{ type: string; text: string }> }
      const resultB = (await toolsB['create_mockup'].handler({ html: '<p>B</p>' })) as { content: Array<{ type: string; text: string }> }

      const idA = /Directory:\s*(\S+)/.exec(resultA.content[0].text)![1]
      const idB = /Directory:\s*(\S+)/.exec(resultB.content[0].text)![1]

      // Each mockup lands in its own cwd.
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', idA, 'index.html'))).toBe(true)
      expect(existsSync(join(tmp2, '.claude', 'ui', 'mockups', idB, 'index.html'))).toBe(true)
      // Not crossed.
      expect(existsSync(join(tmp2, '.claude', 'ui', 'mockups', idA, 'index.html'))).toBe(false)
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', idB, 'index.html'))).toBe(false)
    } finally {
      await rm(tmp2, { recursive: true, force: true })
    }
  })
})
