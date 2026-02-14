import { useMemo } from 'react'
import { Highlight, themes } from 'prism-react-renderer'

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', css: 'css', scss: 'scss', html: 'markup', xml: 'markup',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql', swift: 'swift',
  dockerfile: 'docker', makefile: 'makefile',
}

function getLang(filePath?: string): string {
  if (!filePath) return 'plaintext'
  const name = filePath.split('/').pop()?.toLowerCase() || ''
  // Handle extensionless files like Dockerfile, Makefile
  if (EXT_TO_LANG[name]) return EXT_TO_LANG[name]
  const ext = name.split('.').pop() || ''
  return EXT_TO_LANG[ext] || 'plaintext'
}

/** Strip `cat -n` style line-number prefixes (e.g. "     1→content") */
function stripLineNumbers(s: string): string {
  return s.replace(/^ *\d+→/gm, '')
}

/** Extract the starting line number from cat -n output, defaulting to 1 */
function getStartLine(s: string): number {
  const match = s.match(/^ *(\d+)→/)
  return match ? parseInt(match[1], 10) : 1
}

interface Props {
  code: string
  filePath?: string
}

export function CodeView({ code, filePath }: Props): React.JSX.Element {
  const startLine = useMemo(() => getStartLine(code), [code])
  const cleaned = useMemo(() => stripLineNumbers(code), [code])
  // Trim trailing newline to avoid an empty last line
  const trimmed = cleaned.endsWith('\n') ? cleaned.slice(0, -1) : cleaned
  const lang = getLang(filePath)

  return (
    <Highlight theme={themes.oneDark} code={trimmed} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          className="text-[11px] font-mono leading-[1.3] rounded-md border border-border overflow-auto"
          style={{ background: 'var(--color-bg-primary)' }}
        >
          <code>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line })
              return (
                <div key={i} {...lineProps} className="flex" style={undefined}>
                  <span className="shrink-0 w-10 text-right pr-3 select-none text-text-muted/50 text-[11px]">
                    {startLine + i}
                  </span>
                  <span className="flex-1 px-2">
                    {line.map((token, j) => (
                      <span key={j} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              )
            })}
          </code>
        </pre>
      )}
    </Highlight>
  )
}
