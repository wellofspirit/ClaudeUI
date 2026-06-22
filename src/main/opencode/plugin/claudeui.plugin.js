/**
 * ClaudeUI hosted-tools opencode plugin (Phase 5c — Part B).
 *
 * Auto-loaded by opencode from ~/.config/opencode/plugin/claudeui.plugin.js
 * (installed + version-stamped by ensureOpencodePlugin() — see ../ensure-plugin.ts).
 *
 * Registers three tools that mirror ClaudeUI's in-process MCP tools so the
 * existing renderer cards (the diagram/mockup kind bodies) + the `mockup-asset://`
 * protocol serving work unchanged. As of Phase 6 the renderer's
 * OpencodeEngineToolMap classifies these RAW tool names to ToolKinds
 * (render_mermaid→diagram, create_mockup/show_mockup→mockup) and its `normalize`
 * reads the args below — so the arg names here MUST stay in sync with what the
 * diagram/mockup bodies consume (source/title, directory/title):
 *   - render_mermaid : { source, title? }
 *   - create_mockup  : { html, title? }   → result text + on-disk layout MUST match mockup-tool.ts
 *   - show_mockup    : { directory }
 *
 * This file runs INSIDE opencode's own Bun process. It CANNOT import ClaudeUI
 * main-process code — the mermaid/mockup logic is self-contained (node fs/crypto).
 * `@opencode-ai/plugin` is provided by opencode at load time; it is NOT a
 * ClaudeUI dependency (never add it to package.json).
 *
 * VERSION: bump CLAUDEUI_PLUGIN_VERSION whenever this file's behavior changes so
 * ensureOpencodePlugin() re-stamps the installed copy.
 */

import { tool } from '@opencode-ai/plugin'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Bumped on any behavior change so the installer overwrites stale copies.
 * NOT exported: opencode's plugin loader treats every named export as a Plugin
 * function and rejects the module ("Plugin export is not a function") if any
 * export isn't callable. ensureOpencodePlugin() reads this via regex, not import.
 */
const CLAUDEUI_PLUGIN_VERSION = '1.0.0'
void CLAUDEUI_PLUGIN_VERSION

// ── HTML helpers (ported verbatim from src/main/services/mockup-tool.ts) ──────

/**
 * Wraps body HTML in a full document template.
 * MUST stay byte-identical to mockup-tool.ts:wrapHtml so the renderer's
 * mockup-asset:// serving + bridge injection behave the same.
 */
function wrapHtml(bodyHtml, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title || 'Mockup')}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── cwd resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the session cwd that the ClaudeUI RENDERER serves mockups from.
 *
 * CRITICAL: this must equal `OpencodeSession.cwd` (what the renderer uses to
 * build the `mockup-asset://` URL), NOT opencode's `ToolContext.directory` —
 * opencode resolves `directory` to the *project/git root*, which differs from
 * the session cwd whenever the session opens a subdir of a repo. ClaudeUI sets
 * `CLAUDEUI_SESSION_CWD` in the opencode server spawn env (OpencodeServerManager)
 * to the exact session cwd, so we prefer that. The remaining fallbacks only
 * matter when the plugin runs outside a ClaudeUI-spawned server.
 */
function resolveCwd(toolCtx, pluginDir) {
  return (
    process.env.CLAUDEUI_SESSION_CWD ||
    toolCtx?.directory ||
    toolCtx?.worktree ||
    pluginDir ||
    process.cwd()
  )
}

// ── Plugin entry ──────────────────────────────────────────────────────────────

export const ClaudeUIPlugin = async (input) => {
  // input.directory / input.worktree are the plugin-level project dir (fallbacks).
  const pluginDir = input?.directory || input?.worktree || undefined

  return {
    tool: {
      render_mermaid: tool({
        description:
          'Render a Mermaid diagram inline in the ClaudeUI chat. Pass the Mermaid ' +
          'source; the diagram renders as a card. Use for flowcharts, sequence ' +
          'diagrams, ER diagrams, state machines, gantt charts, etc.',
        args: {
          source: tool.schema
            .string()
            .describe('The Mermaid diagram source (e.g. "graph TD; A-->B;")'),
          title: tool.schema.string().optional().describe('Optional title shown on the card')
        },
        async execute(args) {
          // No @mermaid-js/parser validation — it is not in opencode's runtime;
          // the ClaudeUI renderer validates the diagram visually.
          const { title } = args
          return `${title ? `"${title}"` : 'Diagram'} rendered successfully.`
        }
      }),

      create_mockup: tool({
        description:
          'Create a new UI mockup. Scaffolds a directory on disk and writes the ' +
          'initial HTML. The mockup renders inline in the chat as a preview card. ' +
          'Returns the directory ID for future reference — use the standard Edit ' +
          'tool to modify the HTML file for incremental changes, then call ' +
          'show_mockup to re-display the updated result. Write only the <body> ' +
          'content as `html`; Tailwind v3 is auto-loaded from the Play CDN.',
        args: {
          html: tool.schema
            .string()
            .describe(
              'The HTML body content for the mockup. Write only the content that ' +
                'goes inside <body> — Tailwind CSS is automatically loaded from the ' +
                'Play CDN (v3). Inline <script> and <style> blocks are allowed.'
            ),
          title: tool.schema.string().optional().describe('Title shown on the mockup preview card')
        },
        async execute(args, context) {
          const { html, title } = args
          const cwd = resolveCwd(context, pluginDir)
          const mockupsRoot = join(cwd, '.claude', 'ui', 'mockups')
          try {
            const id = randomBytes(4).toString('hex')
            const dir = join(mockupsRoot, id)
            await mkdir(dir, { recursive: true })

            const indexHtml = wrapHtml(html, title)
            await writeFile(join(dir, 'index.html'), indexHtml, 'utf-8')

            const relPath = `.claude/ui/mockups/${id}`
            // Result text MUST match mockup-tool.ts:create_mockup byte-for-byte so
            // extractMockupDirectory() in the renderer parses the directory id.
            return `Mockup created successfully.\nDirectory: ${id}\nPath: ${relPath}\nFile: ${relPath}/index.html\n\nTo modify this mockup, use the Edit tool on ${relPath}/index.html — the preview auto-refreshes on file change.`
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return `Failed to create mockup: ${message}`
          }
        }
      }),

      show_mockup: tool({
        description:
          'Display an existing mockup from disk. Use this when the user wants to ' +
          'see a mockup again and the original card is no longer visible in the ' +
          'conversation.',
        args: {
          directory: tool.schema
            .string()
            .describe('The mockup directory ID (e.g. "a3f8c1d2") returned by create_mockup')
        },
        async execute(args, context) {
          const { directory } = args
          const cwd = resolveCwd(context, pluginDir)
          const mockupsRoot = join(cwd, '.claude', 'ui', 'mockups')
          try {
            const indexPath = join(mockupsRoot, directory, 'index.html')
            await access(indexPath)

            const relPath = `.claude/ui/mockups/${directory}`
            // Result text MUST match mockup-tool.ts:show_mockup byte-for-byte.
            return `Mockup displayed.\nDirectory: ${directory}\nPath: ${relPath}`
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return `Failed to show mockup: ${message}\nMake sure the directory ID is correct and the file exists.`
          }
        }
      })
    }
  }
}

// opencode auto-loads each named export that is a Plugin function. We export
// ONLY ClaudeUIPlugin — no default, no non-function exports (the loader rejects
// a module with any non-callable export). Verified against opencode 1.17.9.
