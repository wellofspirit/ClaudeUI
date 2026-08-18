/**
 * The shared remote sign-in flow (ADR-057 / S4-UI) — mockup states 2, 3 and 4.
 *
 * What matters here and is easy to break silently:
 *  - the two VARIANTS say different things (Codex/opencode paste a dead URL;
 *    claude.ai shows a code on its page);
 *  - step 2 posts the pasted string VERBATIM apart from trimming, exactly once.
 *    Any client-side parsing would fork the backend's shape-dependent CSRF rule
 *    (`parsePastedCallback`), which is the one thing this flow must not do;
 *  - the outcome mapping. An unrecognized backend error must survive to the
 *    screen unchanged rather than being flattened into a friendly lie.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DESKTOP_ONLY_COPY,
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  STATE_MISMATCH_COPY,
  classifyOAuthError
} from '../OAuthPasteBackFlow'

beforeEach(() => {
  window.open = vi.fn() as unknown as typeof window.open
})
afterEach(cleanup)

describe('OAuthPasteBackFlow — the two variants', () => {
  it('the url variant explains the failed page and offers the address-bar paste', () => {
    render(<OAuthPasteBackFlow variant="url" url="https://auth.example/authorize" onSubmit={vi.fn()} />)
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'url')
    expect(flow).toHaveTextContent('Sign in with your browser')
    expect(flow).toHaveTextContent('Paste what you got back')
    expect(flow).toHaveTextContent('fails to load')
    expect(screen.getByTestId('OAuthPasteBackFlow.input')).toHaveAttribute(
      'placeholder',
      'http://localhost:1455/auth/callback?code=… or the code'
    )
  })

  it('the code variant names claude.ai and drops the failed-URL language', () => {
    render(<OAuthPasteBackFlow variant="code" url="https://claude.ai/oauth" onSubmit={vi.fn()} />)
    const flow = screen.getByTestId('OAuthPasteBackFlow')
    expect(flow).toHaveAttribute('data-variant', 'code')
    expect(flow).toHaveTextContent('Paste the code claude.ai shows you')
    expect(flow).not.toHaveTextContent('fails to load')
    expect(screen.getByTestId('OAuthPasteBackFlow.input')).toHaveAttribute(
      'placeholder',
      'Paste authorization code'
    )
  })
})

describe('OAuthPasteBackFlow — step 1 opens on the CLIENT', () => {
  it('the button opens the authorize url in a new tab from the user gesture', () => {
    render(<OAuthPasteBackFlow variant="url" url="https://auth.example/a?state=s" onSubmit={vi.fn()} />)
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).toHaveBeenCalledWith(
      'https://auth.example/a?state=s',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('without a url the button is disabled and says so — never opens about:blank', () => {
    render(<OAuthPasteBackFlow variant="url" onSubmit={vi.fn()} />)
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.open'))
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.getByTestId('OAuthPasteBackFlow.open')).toBeDisabled()
    expect(screen.getByTestId('OAuthPasteBackFlow')).toHaveTextContent(
      'The host did not return a sign-in link.'
    )
  })
})

describe('OAuthPasteBackFlow — step 2 submits verbatim, once', () => {
  const pastedUrl = 'http://localhost:1455/auth/callback?code=abc&state=xyz'

  it('hands the whole pasted URL through untouched (no client-side parsing)', () => {
    const onSubmit = vi.fn()
    render(<OAuthPasteBackFlow variant="url" url="https://a" onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: pastedUrl }
    })
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(pastedUrl)
  })

  it('trims surrounding whitespace and nothing else', () => {
    const onSubmit = vi.fn()
    render(<OAuthPasteBackFlow variant="code" url="https://a" onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), {
      target: { value: '  bare-code-123\n' }
    })
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    expect(onSubmit).toHaveBeenCalledWith('bare-code-123')
  })

  it('Enter in the field submits the same way', () => {
    const onSubmit = vi.fn()
    render(<OAuthPasteBackFlow variant="code" url="https://a" onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: 'c1' } })
    fireEvent.keyDown(screen.getByTestId('OAuthPasteBackFlow.input'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('an empty (or whitespace-only) field cannot submit', () => {
    const onSubmit = vi.fn()
    render(<OAuthPasteBackFlow variant="code" url="https://a" onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('OAuthPasteBackFlow.input'), { target: { value: '   ' } })
    expect(screen.getByTestId('OAuthPasteBackFlow.submit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.submit'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('busy locks the field and both buttons so one paste cannot be double-sent', () => {
    const onSubmit = vi.fn()
    render(<OAuthPasteBackFlow variant="url" url="https://a" busy onSubmit={onSubmit} />)
    expect(screen.getByTestId('OAuthPasteBackFlow.input')).toBeDisabled()
    expect(screen.getByTestId('OAuthPasteBackFlow.submit')).toBeDisabled()
    expect(screen.getByTestId('OAuthPasteBackFlow.open')).toBeDisabled()
  })
})

describe('OAuthPasteBackFlow — cancel', () => {
  it('renders Cancel only when the surface supplied a handler', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <OAuthPasteBackFlow variant="url" url="https://a" onSubmit={vi.fn()} />
    )
    expect(screen.queryByTestId('OAuthPasteBackFlow.cancel')).toBeNull()
    rerender(
      <OAuthPasteBackFlow variant="url" url="https://a" onSubmit={vi.fn()} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByTestId('OAuthPasteBackFlow.cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('classifyOAuthError — the mockup outcome mapping', () => {
  it('maps the CSRF/state rejection to "start again from step 1"', () => {
    expect(classifyOAuthError('Invalid state - potential CSRF attack')).toBe('state-mismatch')
    expect(classifyOAuthError('OAuth state mismatch')).toBe('state-mismatch')
  })

  it('maps the remote-`auto` refusal to the desktop-only outcome', () => {
    expect(
      classifyOAuthError(
        "opencode's automatic browser sign-in only completes on the host machine. " +
          "Choose the 'paste a code' method, or sign in from the desktop app."
      )
    ).toBe('desktop-only')
  })

  it('leaves anything else as a verbatim error', () => {
    expect(classifyOAuthError('Token exchange failed: 400 - {"error":"invalid_grant"}')).toBe(
      'error'
    )
  })
})

describe('OAuthOutcomeNotice — copy per kind', () => {
  it('renders the mockup copy for the two classified kinds and the raw text otherwise', () => {
    const { rerender } = render(<OAuthOutcomeNotice kind="state-mismatch" message="Invalid state" />)
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent(STATE_MISMATCH_COPY)
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveAttribute('data-kind', 'state-mismatch')

    rerender(<OAuthOutcomeNotice kind="desktop-only" message="whatever the backend said" />)
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent(DESKTOP_ONLY_COPY)

    rerender(<OAuthOutcomeNotice kind="error" message="Token exchange failed: 500" />)
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent('Token exchange failed: 500')
  })
})

describe('OAuthPasteBackFlow — inline outcome', () => {
  it('classifies the submit error into the mockup row', () => {
    render(
      <OAuthPasteBackFlow
        variant="url"
        url="https://a"
        error="Invalid state - potential CSRF attack"
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByTestId('OAuthOutcomeNotice')).toHaveTextContent(STATE_MISMATCH_COPY)
  })
})
