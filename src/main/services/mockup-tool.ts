import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk/types'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { join } from 'path'

/**
 * Creates an in-process MCP server that provides mockup tools:
 * - `create_mockup`: scaffold a mockup directory and write initial HTML
 * - `show_mockup`: re-display an existing mockup from disk
 */
export function createMockupServer(cwd: string): SdkMcpServer {
  const mockupsRoot = join(cwd, '.claude', 'ui', 'mockups')

  return createSdkMcpServer({
    name: 'claude-ui-mockup',
    version: '1.0.0',
    tools: [
      tool(
        'create_mockup',
        'Create a new UI mockup. Scaffolds a directory on disk and writes the initial HTML. ' +
          'The mockup renders inline in the chat as a preview card. ' +
          'Returns the directory ID for future reference — use the standard Edit tool to modify the HTML file for incremental changes, ' +
          'then call show_mockup to re-display the updated result.\n\n' +
          'Sibling assets: You may drop additional files (images, custom CSS, fonts, JS) into the mockup directory ' +
          'alongside index.html and reference them with relative paths, e.g. `<img src="./logo.png">`, ' +
          '`<link rel="stylesheet" href="./extra.css">`, `<script src="./app.js"></script>`. ' +
          'Supported extensions: png, jpg, jpeg, gif, webp, avif, svg, ico, woff, woff2, ttf, otf, css, js, mjs, json, txt, mp3, mp4, webm.\n\n' +
          'JavaScript runs: the iframe is sandboxed to its own origin and allows scripts. ' +
          'Tailwind v3 is loaded from the Play CDN (`cdn.tailwindcss.com`), so standard utility classes work. ' +
          'You can also pull other libraries from jsdelivr, cdnjs, unpkg, or jQuery CDN. ' +
          "Network requests via fetch/XHR/WebSocket are constrained by CSP to the user's configured allowlist — " +
          'prefer in-mockup data over arbitrary remote calls.',
        {
          html: z
            .string()
            .describe(
              'The HTML body content for the mockup. Write only the content that goes inside <body> — ' +
                'Tailwind CSS is automatically loaded from the Play CDN (v3). ' +
                'Use standard Tailwind v3 utility classes for styling. Inline <script> and <style> blocks are allowed.'
            ),
          title: z.string().optional().describe('Title shown on the mockup preview card')
        },
        async ({ html, title }) => {
          try {
            const id = randomBytes(4).toString('hex')
            const dir = join(mockupsRoot, id)
            await mkdir(dir, { recursive: true })

            const indexHtml = wrapHtml(html, title)
            await writeFile(join(dir, 'index.html'), indexHtml, 'utf-8')

            const relPath = `.claude/ui/mockups/${id}`
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Mockup created successfully.\nDirectory: ${id}\nPath: ${relPath}\nFile: ${relPath}/index.html\n\nTo modify this mockup, use the Edit tool on ${relPath}/index.html — the preview auto-refreshes on file change.`
                }
              ]
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `Failed to create mockup: ${message}` }],
              isError: true
            }
          }
        }
      ),

      tool(
        'show_mockup',
        'Display an existing mockup from disk. Use this when the user wants to see a mockup again and the original card is no longer visible in the conversation.',
        {
          directory: z
            .string()
            .describe('The mockup directory ID (e.g., "a3f8c1d2") returned by create_mockup')
        },
        async ({ directory }) => {
          try {
            const indexPath = join(mockupsRoot, directory, 'index.html')
            await access(indexPath)
            await readFile(indexPath, 'utf-8')

            const relPath = `.claude/ui/mockups/${directory}`
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Mockup displayed.\nDirectory: ${directory}\nPath: ${relPath}`
                }
              ]
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to show mockup: ${message}\nMake sure the directory ID is correct and the file exists.`
                }
              ],
              isError: true
            }
          }
        }
      )
    ]
  })
}

/**
 * Wraps body HTML in a full document template.
 * Tailwind v3 loads from the Play CDN so exported mockups open standalone
 * via file:// without our custom protocol handler.
 *
 * The "omelette" bridge script (console forwarding, auto-resize, reload
 * handler) is NOT baked in here — it's injected at serve time by the
 * protocol handler. That way bug fixes and new bridge features apply to
 * every stored mockup instantly, without having to rewrite files.
 */
export function wrapHtml(bodyHtml: string, title?: string): string {
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
