/**
 * @vitest-environment node
 *
 * Unit tests for the hosted-tools opencode plugin (Phase 5c — Part B).
 *
 * Imports the real plugin module (claudeui.plugin.js) — `@opencode-ai/plugin` is
 * aliased to a test stub (see vitest.config.ts) — and calls each tool's execute()
 * directly with a temp cwd. No opencode binary needed.
 *
 * Asserts:
 *   - render_mermaid returns the exact success string (with/without title)
 *   - create_mockup writes <cwd>/.claude/ui/mockups/<id>/index.html with the
 *     wrapped HTML + returns the exact result text (byte-identical to mockup-tool.ts)
 *   - show_mockup checks existence + returns the exact result text
 *   - ToolContext.directory is preferred over the plugin-level dir for cwd
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeUIPlugin } from '../plugin/claudeui.plugin.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PluginTools {
  render_mermaid: { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }
  create_mockup: { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }
  show_mockup: { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }
}

async function loadTools(pluginDir?: string): Promise<PluginTools> {
  // The Plugin fn is async and returns { tool: {...} }
  const hooks = await ClaudeUIPlugin({ directory: pluginDir } as never)
  return hooks.tool as unknown as PluginTools
}

/** Build a minimal ToolContext carrying a directory (the per-call cwd). */
function ctx(directory: string): unknown {
  return { directory, worktree: directory }
}

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'claudeui-plugin-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// render_mermaid
// ---------------------------------------------------------------------------

describe('plugin: render_mermaid', () => {
  it('returns "Diagram rendered successfully." without a title', async () => {
    const tools = await loadTools()
    const out = await tools.render_mermaid.execute({ source: 'graph TD; A-->B;' }, ctx(tmp))
    expect(out).toBe('Diagram rendered successfully.')
  })

  it('returns the quoted title in the success string', async () => {
    const tools = await loadTools()
    const out = await tools.render_mermaid.execute(
      { source: 'graph TD; A-->B;', title: 'My Flow' },
      ctx(tmp)
    )
    expect(out).toBe('"My Flow" rendered successfully.')
  })
})

// ---------------------------------------------------------------------------
// create_mockup
// ---------------------------------------------------------------------------

describe('plugin: create_mockup', () => {
  it('writes <cwd>/.claude/ui/mockups/<id>/index.html with wrapped HTML', async () => {
    const tools = await loadTools()
    const body = '<h1 class="text-2xl">Hello</h1>'
    const out = (await tools.create_mockup.execute(
      { html: body, title: 'Greeting' },
      ctx(tmp)
    )) as string

    // Parse the directory id out of the result text
    const m = /Directory:\s*(\S+)/.exec(out)
    expect(m).not.toBeNull()
    const id = m![1]

    const indexPath = join(tmp, '.claude', 'ui', 'mockups', id, 'index.html')
    expect(existsSync(indexPath)).toBe(true)

    const html = await readFile(indexPath, 'utf-8')
    // Wrapped document shape (matches mockup-tool.ts:wrapHtml)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>Greeting</title>')
    expect(html).toContain('https://cdn.tailwindcss.com')
    expect(html).toContain(body)
  })

  it('returns the exact result text (matches mockup-tool.ts byte-for-byte)', async () => {
    const tools = await loadTools()
    const out = (await tools.create_mockup.execute({ html: '<div>x</div>' }, ctx(tmp))) as string

    const m = /Directory:\s*(\S+)/.exec(out)
    const id = m![1]
    const relPath = `.claude/ui/mockups/${id}`
    const expected = `Mockup created successfully.\nDirectory: ${id}\nPath: ${relPath}\nFile: ${relPath}/index.html\n\nTo modify this mockup, use the Edit tool on ${relPath}/index.html — the preview auto-refreshes on file change.`
    expect(out).toBe(expected)
  })

  it('generates an 8-char hex directory id', async () => {
    const tools = await loadTools()
    const out = (await tools.create_mockup.execute({ html: '<div>x</div>' }, ctx(tmp))) as string
    const m = /Directory:\s*(\S+)/.exec(out)
    expect(m![1]).toMatch(/^[0-9a-f]{8}$/)
  })

  it('prefers ToolContext.directory over the plugin-level directory', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'claudeui-plugindir-'))
    try {
      const tools = await loadTools(pluginDir)
      // Pass a DIFFERENT directory via the per-call ToolContext
      const out = (await tools.create_mockup.execute({ html: '<div>x</div>' }, ctx(tmp))) as string
      const id = /Directory:\s*(\S+)/.exec(out)![1]

      // File must land under the ToolContext dir (tmp), NOT the plugin dir
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', id, 'index.html'))).toBe(true)
      expect(existsSync(join(pluginDir, '.claude', 'ui', 'mockups', id, 'index.html'))).toBe(false)
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })

  it('prefers CLAUDEUI_SESSION_CWD over ToolContext.directory (renderer-cwd match)', async () => {
    // ClaudeUI sets CLAUDEUI_SESSION_CWD to the exact session cwd the renderer
    // serves mockups from; it must win over opencode's ToolContext.directory
    // (which resolves to the git root and can differ for subdir sessions).
    const sessionCwd = await mkdtemp(join(tmpdir(), 'claudeui-sessioncwd-'))
    const ctxDir = await mkdtemp(join(tmpdir(), 'claudeui-ctxdir-'))
    const prev = process.env.CLAUDEUI_SESSION_CWD
    process.env.CLAUDEUI_SESSION_CWD = sessionCwd
    try {
      const tools = await loadTools()
      const out = (await tools.create_mockup.execute({ html: '<div>x</div>' }, ctx(ctxDir))) as string
      const id = /Directory:\s*(\S+)/.exec(out)![1]
      expect(existsSync(join(sessionCwd, '.claude', 'ui', 'mockups', id, 'index.html'))).toBe(true)
      expect(existsSync(join(ctxDir, '.claude', 'ui', 'mockups', id, 'index.html'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.CLAUDEUI_SESSION_CWD
      else process.env.CLAUDEUI_SESSION_CWD = prev
      await rm(sessionCwd, { recursive: true, force: true })
      await rm(ctxDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// show_mockup
// ---------------------------------------------------------------------------

describe('plugin: show_mockup', () => {
  it('returns the exact "Mockup displayed" text when the file exists', async () => {
    const id = 'abc12345'
    const dir = join(tmp, '.claude', 'ui', 'mockups', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.html'), '<html></html>', 'utf-8')

    const tools = await loadTools()
    const out = (await tools.show_mockup.execute({ directory: id }, ctx(tmp))) as string
    const relPath = `.claude/ui/mockups/${id}`
    expect(out).toBe(`Mockup displayed.\nDirectory: ${id}\nPath: ${relPath}`)
  })

  it('returns a failure message when the mockup does not exist', async () => {
    const tools = await loadTools()
    const out = (await tools.show_mockup.execute({ directory: 'nope9999' }, ctx(tmp))) as string
    expect(out).toContain('Failed to show mockup')
    expect(out).toContain('Make sure the directory ID is correct')
  })
})
