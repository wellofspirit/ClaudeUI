/**
 * detail kind body — a named-field list, and what the call returned.
 *
 * The shape for a tool whose call is a handful of facts: a cron expression and
 * its prompt, a worktree and its branch, a wake-up and its reason, a skill and
 * its arguments. The per-tool spec decides which fields exist and in what order
 * (`claude-tool-specs.ts`); this only renders them.
 *
 * `text` is what came BACK, so it renders through the output view — a skill's
 * loaded instructions, a monitor's events, a background task's stdout all get
 * the same detection the shell result does, rather than being flattened into
 * another field row.
 */

import { OutputView } from '../../OutputView'
import type { KindBodyProps } from './types'

export function DetailBody({
  view,
  result,
  toolOutputMaxChars = 5000
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'detail') return null

  const text = view.text ?? result?.toolResult ?? ''
  const isError = !!result?.isError
  const hasFields = view.fields.length > 0

  return (
    <>
      {hasFields && (
        <dl
          data-testid="DetailBody"
          className="px-3 py-2.5 grid grid-cols-[minmax(72px,auto)_1fr] gap-x-3 gap-y-1 text-[12px]"
        >
          {view.fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-text-secondary">{field.label}</dt>
              <dd className="m-0 font-mono text-[11.5px] text-text-primary/80 break-words whitespace-pre-wrap">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {!!text && (
        <div className={`px-3 py-2.5 ${hasFields ? 'border-t border-border' : ''}`}>
          {isError ? (
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
              {text.slice(0, toolOutputMaxChars)}
            </pre>
          ) : (
            <OutputView text={text} />
          )}
        </div>
      )}
    </>
  )
}
