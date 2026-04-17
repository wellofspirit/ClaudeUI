import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { join } from 'path'

/**
 * Creates an in-process MCP server that provides mockup tools:
 * - `create_mockup`: scaffold a mockup directory and write initial HTML
 * - `show_mockup`: re-display an existing mockup from disk
 */
export function createMockupServer(cwd: string) {
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
          'Sibling assets: You may drop additional files (images, custom CSS, fonts) into the mockup directory ' +
          'alongside index.html and reference them with relative paths, e.g. `<img src="./logo.png">`, ' +
          '`<link rel="stylesheet" href="./extra.css">`. Supported extensions: png, jpg, jpeg, gif, webp, ' +
          'avif, svg, ico, woff, woff2, ttf, otf, css, json, txt, mp3, mp4, webm.\n\n' +
          'JavaScript is NOT executed in mockups (the iframe is sandboxed and the CSP blocks scripts). ' +
          'For interactivity, use CSS-only patterns: `:hover`, `:focus-within`, `:checked + label` for toggles, ' +
          '`<details>/<summary>` for disclosures, `:target` for tabbed panels.',
        {
          html: z.string().describe(
            'The HTML body content for the mockup. Write only the content that goes inside <body> — ' +
            'Tailwind CSS is automatically available. Use standard Tailwind utility classes for styling.'
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
              content: [{
                type: 'text' as const,
                text: `Mockup created successfully.\nDirectory: ${id}\nPath: ${relPath}\nFile: ${relPath}/index.html\n\nTo modify this mockup, use the Edit tool on ${relPath}/index.html — the preview auto-refreshes on file change.`
              }]
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
          directory: z.string().describe('The mockup directory ID (e.g., "a3f8c1d2") returned by create_mockup')
        },
        async ({ directory }) => {
          try {
            const indexPath = join(mockupsRoot, directory, 'index.html')
            await access(indexPath)
            // Read file to verify it exists and is valid
            await readFile(indexPath, 'utf-8')

            const relPath = `.claude/ui/mockups/${directory}`
            return {
              content: [{
                type: 'text' as const,
                text: `Mockup displayed.\nDirectory: ${directory}\nPath: ${relPath}`
              }]
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {
              content: [{
                type: 'text' as const,
                text: `Failed to show mockup: ${message}\nMake sure the directory ID is correct and the file exists.`
              }],
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
 * The Tailwind stylesheet is referenced via the `mockup-asset://` custom
 * protocol so the iframe's HTTP cache serves it across every reload.
 */
function wrapHtml(bodyHtml: string, title?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title || 'Mockup')}</title>
  <link rel="stylesheet" href="mockup-asset://tailwind.css">
</head>
<body>
${bodyHtml}
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
