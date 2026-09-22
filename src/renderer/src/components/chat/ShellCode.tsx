/**
 * ShellCode — a command, highlighted, with each heredoc body in its own language.
 *
 * The command block is not decoration: a Bash input is routinely longer than the
 * card header can hold, and seeing exactly what ran is a security affordance,
 * which is why the card renders it even under `hide tool input`. This component
 * only makes it legible.
 *
 * Wrapping, not scrolling sideways: a command that ran off the edge would hide
 * the tail of what is about to execute, and the tail is the part that matters.
 */

import { Highlight, themes } from 'prism-react-renderer'
import { splitHeredocs, type CommandSegment } from '../../lib/shell-highlight'

interface Props {
  command: string
  /** Renders the `$` prompt on the first line — the shape the card has always had. */
  prompt?: boolean
}

function Segment({
  segment,
  showPrompt
}: {
  segment: CommandSegment
  showPrompt: boolean
}): React.JSX.Element {
  // Prism emits a trailing empty line for text ending in a newline; segments are
  // rendered back to back, so that blank would open a gap between them.
  const code = segment.text.endsWith('\n') ? segment.text.slice(0, -1) : segment.text
  return (
    <Highlight theme={themes.oneDark} code={code} language={segment.lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <>
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })} style={undefined}>
              {showPrompt && i === 0 && <span className="select-none text-text-muted">$ </span>}
              {line.map((token, j) => (
                <span key={j} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </>
      )}
    </Highlight>
  )
}

export function ShellCode({ command, prompt = true }: Props): React.JSX.Element {
  const segments = splitHeredocs(command)

  return (
    <pre
      data-testid="ShellCode"
      className="text-[12px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border"
    >
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} showPrompt={prompt && i === 0} />
      ))}
    </pre>
  )
}
