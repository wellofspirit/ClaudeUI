import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Top-level error boundary (M-RN2). Without one, a single render-time throw
 * anywhere in the tree (e.g. a malformed approval dereferenced in
 * FloatingApproval) unmounts the entire app to a blank white screen with no
 * recovery. This catches the throw, logs it to the main-process log file, and
 * renders a minimal fallback with a reload affordance so the user isn't stranded.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detail = `${error.stack ?? error.message}\n\nComponent stack:${info.componentStack ?? ''}`
    // window.api may be absent in some non-Electron test harnesses — guard it.
    window.api?.logError?.('ErrorBoundary', detail)
  }

  private handleReload = (): void => {
    this.setState({ error: null })
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          data-testid="ErrorBoundary.fallback"
          className="flex h-full w-full items-center justify-center bg-bg-primary p-6"
        >
          <div className="max-w-md text-center">
            <h1 className="mb-2 text-lg font-semibold text-text-primary">Something went wrong</h1>
            <p className="mb-4 text-sm text-text-secondary">
              The interface hit an unexpected error. Reloading usually recovers it; the details have
              been written to the log.
            </p>
            <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-secondary p-2 text-left text-[11px] text-text-muted">
              {this.state.error.message}
            </pre>
            <button
              data-testid="ErrorBoundary.reload"
              onClick={this.handleReload}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
