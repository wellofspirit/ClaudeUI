import { describe, expect, it } from 'vitest'
import { desktopAppEntries } from '../codex-desktop-entries'

/**
 * F17 step 1 — the detection rule, pure.
 *
 * The shapes below are the OWNER's real `~/.codex` as recorded on 2026-09-16
 * (names and counts only, fabricated here), which is what makes these cases
 * worth anything: the override is derived from this function, and an override
 * for a table the user does not have creates a transport-less MCP server and
 * fails config load.
 */
describe('desktopAppEntries', () => {
  /** The desktop app's own entries, as it writes them into a shared `~/.codex`. */
  const desktopConfig = {
    model: 'gpt-6-astra',
    mcp_servers: {
      node_repl: {
        command: '/Applications/Codex.app/Contents/Resources/bin/node-repl',
        args: ['--stdio']
      },
      cua_repl: { command: '/Applications/Codex.app/Contents/Resources/bin/cua-repl' },
      'computer-use': { command: '/Applications/Codex.app/Contents/Resources/bin/computer-use' },
      // The user's own, and the whole reason detection is per entry: it must
      // survive untouched.
      docs: { command: 'node', args: ['docs-server.js'] }
    },
    marketplaces: {
      'openai-bundled': { path: '~/.codex/.tmp/bundled-marketplaces/openai-bundled' }
    },
    plugins: {
      'browser@openai-bundled': { enabled: true },
      'codex-app-tools@openai-bundled': { enabled: true },
      'computer-use@openai-bundled': { enabled: true },
      'visualize@openai-bundled': { enabled: true },
      // A DIFFERENT local marketplace: documents/pdf/spreadsheets are the
      // primary runtime, not the desktop app's surfaces, and they stay.
      'documents@openai-primary-runtime': { enabled: true },
      'my-plugin@my-marketplace': { enabled: true }
    }
  }

  it("finds the desktop app's servers and its bundled plugins, and nothing else", () => {
    expect(desktopAppEntries(desktopConfig)).toEqual({
      mcpServers: ['computer-use', 'cua_repl', 'node_repl'],
      plugins: [
        'browser@openai-bundled',
        'codex-app-tools@openai-bundled',
        'computer-use@openai-bundled',
        'visualize@openai-bundled'
      ]
    })
  })

  it('finds nothing in a config that has none of it — the override must stay absent', () => {
    expect(
      desktopAppEntries({
        model: 'gpt-6-astra',
        mcp_servers: { docs: { command: 'node', args: ['docs-server.js'] } },
        plugins: { 'documents@openai-primary-runtime': { enabled: true } }
      })
    ).toEqual({ mcpServers: [], plugins: [] })
  })

  it('disables a user-authored server that TOOK one of the desktop names', () => {
    // Documented and deliberate: the name belongs to the desktop app's runtime,
    // the user's file is never written, and the same server keeps working in
    // the desktop app and the TUI. The safe direction for a name collision.
    expect(
      desktopAppEntries({ mcp_servers: { node_repl: { command: '/usr/local/bin/my-repl' } } })
        .mcpServers
    ).toEqual(['node_repl'])
  })

  it('matches any command inside a macOS app bundle, whatever the server is called', () => {
    expect(
      desktopAppEntries({
        mcp_servers: {
          'future-desktop-thing': {
            command: '/Applications/Codex.app/Contents/MacOS/some-new-server'
          }
        }
      }).mcpServers
    ).toEqual(['future-desktop-thing'])
  })

  it('leaves an ordinary Windows path alone', () => {
    // The bundle rule normalises separators, so this is the case that proves it
    // is looking for an APP BUNDLE and not merely for a backslash path.
    expect(
      desktopAppEntries({
        mcp_servers: {
          local: { command: 'C:\\Users\\me\\tools\\node_repl.exe' },
          'also-local': { command: 'C:\\Program Files\\App\\contents\\server.exe' }
        }
      }).mcpServers
    ).toEqual([])
  })

  it('survives a config with the tables missing, scalar, or holding junk', () => {
    expect(desktopAppEntries(undefined)).toEqual({ mcpServers: [], plugins: [] })
    expect(desktopAppEntries(null)).toEqual({ mcpServers: [], plugins: [] })
    expect(desktopAppEntries('not a table')).toEqual({ mcpServers: [], plugins: [] })
    expect(desktopAppEntries({})).toEqual({ mcpServers: [], plugins: [] })
    expect(desktopAppEntries({ mcp_servers: 'nonsense', plugins: 7 })).toEqual({
      mcpServers: [],
      plugins: []
    })
    // An entry that is not a table has no `command`, so only the NAME rule can
    // catch it — and it still must.
    expect(desktopAppEntries({ mcp_servers: { node_repl: null, other: null } })).toEqual({
      mcpServers: ['node_repl'],
      plugins: []
    })
  })
})
