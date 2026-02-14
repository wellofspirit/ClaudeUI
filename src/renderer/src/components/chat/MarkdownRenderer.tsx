import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

const components = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-bg-secondary border border-border rounded-md p-3 my-2 overflow-x-auto text-[11px] font-mono leading-[1.6]">
      {children}
    </pre>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    if (!className) {
      return <code className="bg-bg-tertiary px-1 py-px rounded text-[12px] font-mono text-accent">{children}</code>
    }
    return <code className="text-text-primary">{children}</code>
  },
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className="text-accent hover:underline" target="_blank" rel="noreferrer">{children}</a>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-[15px] font-semibold mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-[14px] font-semibold mb-1.5 mt-2.5 first:mt-0">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-[13px] font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-text-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="border-border my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2 rounded-md border border-border">
      <table className="w-full text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-bg-secondary">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => <th className="border-b border-border px-3 py-1.5 text-left text-[11px] font-semibold text-text-secondary">{children}</th>,
  td: ({ children }: { children?: React.ReactNode }) => <td className="border-b border-border px-3 py-1.5">{children}</td>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: { content: string }): React.JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {content}
    </ReactMarkdown>
  )
})
