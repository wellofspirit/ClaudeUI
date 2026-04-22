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
/**
 * create_mockup tool description. Exported so tests can assert that the
 * JSX opt-in guidance survives future edits.
 */
export const CREATE_MOCKUP_DESCRIPTION =
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
  'prefer in-mockup data over arbitrary remote calls.\n\n' +
  '## Default stack: plain HTML + Tailwind + inline <script>\n' +
  'Reach for the lightest tool that does the job. Most mockups only need static HTML with Tailwind classes. ' +
  'For small interactivity (a toggle, a modal, a form with a few fields, a counter, filtering a list), ' +
  'use a short inline `<script>` that mutates the DOM directly. CSS-only patterns also work well: ' +
  '`:hover`, `:focus-within`, `:checked + label`, `<details>/<summary>`, `:target`.\n\n' +
  '## React / JSX — OPT-IN, ASK FIRST\n' +
  'React + Babel Standalone can be loaded from jsDelivr for mockups that genuinely need component-heavy ' +
  'architecture (shared state across many components, non-trivial state machines, prop-drilled design ' +
  'systems, reusable component libraries the mockup is itself demonstrating). This adds ~1MB of CDN ' +
  'downloads and ~100-300ms of runtime JSX compilation on every load, so the cost is real.\n\n' +
  'Before using JSX, you MUST ask the user in chat: "This mockup has enough interactivity that JSX + ' +
  'React would be cleaner than vanilla DOM. Want me to use React (adds ~1MB of CDN scripts + a compile ' +
  'step), or keep it vanilla?" — then wait for their answer. Do not silently introduce React.\n\n' +
  'When they say yes, use this exact scaffold:\n' +
  '```html\n' +
  '<script crossorigin src="https://cdn.jsdelivr.net/npm/react@18/umd/react.development.js"></script>\n' +
  '<script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.development.js"></script>\n' +
  '<script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>\n' +
  '<div id="root"></div>\n' +
  '<script type="text/babel" data-presets="react,typescript">\n' +
  '  function App() { return <div className="p-4">...</div>; }\n' +
  '  ReactDOM.createRoot(document.getElementById("root")).render(<App />);\n' +
  '</script>\n' +
  '```\n' +
  'The runtime auto-populates `data-filename` on each Babel script so stack traces point to useful ' +
  'locations. You can split JSX into sibling `.js` files and reference them with `<script type="text/babel" src="./app.js">`.\n\n' +
  'DO NOT use JSX for: a single toggle, a simple form, a list-with-filter, a tab switcher, a carousel, ' +
  'or anything else a ~30-line inline `<script>` can do. JSX is a prop-heavy component-library tool, ' +
  'not a UI paintbrush.'

export function createMockupServer(cwd: string): SdkMcpServer {
  const mockupsRoot = join(cwd, '.claude', 'ui', 'mockups')

  return createSdkMcpServer({
    name: 'claude-ui-mockup',
    version: '1.0.0',
    tools: [
      tool(
        'create_mockup',
        CREATE_MOCKUP_DESCRIPTION,
        {
          html: z
            .string()
            .describe(
              'The HTML body content for the mockup. Write only the content that goes inside <body> — ' +
                'Tailwind CSS is automatically loaded from the Play CDN (v3). ' +
                'Use standard Tailwind v3 utility classes for styling. Inline <script> and <style> blocks are allowed. ' +
                'Default to vanilla DOM / inline scripts; only use React/JSX after asking the user (see tool description).'
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
