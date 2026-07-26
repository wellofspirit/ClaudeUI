/**
 * Unit tests for the pure shell-security guards (R1/R2).
 *
 * Non-vacuity: every allow-case has a matching block-case that would flip the
 * assertion if the guard were a constant `true`/`false`.
 */
import { describe, it, expect } from 'vitest'
import {
  isAllowedExternalUrl,
  isInAppNavigation,
  isAllowedWebviewNavigation,
  buildVscodeUrl,
  type AppOrigin
} from '../shell-security'

describe('isAllowedExternalUrl (R2 openExternal allowlist)', () => {
  it('allows http/https/mailto', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('https://example.com/path?q=1#h')).toBe(true)
    expect(isAllowedExternalUrl('mailto:foo@bar.com')).toBe(true)
  })

  it('blocks file/javascript/vbscript/vscode and other schemes', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isAllowedExternalUrl('vscode://file/C:/x')).toBe(false)
    expect(isAllowedExternalUrl('ftp://example.com')).toBe(false)
  })

  it('refuses unparseable input', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
  })
})

describe('isInAppNavigation (R1 navigation guard)', () => {
  const devOrigin: AppOrigin = { mode: 'dev-origin', origin: 'http://localhost:5173' }
  const prodOrigin: AppOrigin = { mode: 'file-prefix', prefix: 'file:///d:/app/renderer/' }

  it('dev: allows same origin, blocks foreign origins', () => {
    expect(isInAppNavigation('http://localhost:5173/index.html', devOrigin)).toBe(true)
    expect(isInAppNavigation('http://localhost:5173/#/chat', devOrigin)).toBe(true)
    expect(isInAppNavigation('http://evil.example.com/', devOrigin)).toBe(false)
    expect(isInAppNavigation('https://localhost:5173/', devOrigin)).toBe(false) // scheme differs
    expect(isInAppNavigation('file:///etc/passwd', devOrigin)).toBe(false)
  })

  it('prod: allows renderer-dir file URLs, blocks siblings and remote', () => {
    expect(isInAppNavigation('file:///d:/app/renderer/index.html', prodOrigin)).toBe(true)
    expect(isInAppNavigation('file:///d:/app/renderer/log-viewer.html', prodOrigin)).toBe(true)
    // sibling directory escape must NOT match the prefix
    expect(isInAppNavigation('file:///d:/app/renderer-evil/index.html', prodOrigin)).toBe(false)
    expect(isInAppNavigation('file:///d:/app/other/index.html', prodOrigin)).toBe(false)
    expect(isInAppNavigation('https://example.com/', prodOrigin)).toBe(false)
  })

  it('treats unparseable URLs as foreign (blocked)', () => {
    expect(isInAppNavigation('::::', devOrigin)).toBe(false)
    expect(isInAppNavigation('::::', prodOrigin)).toBe(false)
  })
})

describe('isAllowedWebviewNavigation (xhigh#4 plugin webview)', () => {
  it('allows file://, blocks everything else', () => {
    expect(isAllowedWebviewNavigation('file:///d:/plugins/foo/index.html?pluginId=foo')).toBe(true)
    expect(isAllowedWebviewNavigation('https://evil.example.com/?pluginId=other')).toBe(false)
    expect(isAllowedWebviewNavigation('http://localhost/')).toBe(false)
    expect(isAllowedWebviewNavigation('about:blank')).toBe(false)
    expect(isAllowedWebviewNavigation('data:text/html,<h1>x</h1>')).toBe(false)
  })

  it('refuses unparseable input', () => {
    expect(isAllowedWebviewNavigation('nope')).toBe(false)
  })
})

describe('buildVscodeUrl (R2 vscode cwd hardening)', () => {
  it('builds a vscode://file URL for a normal cwd', () => {
    expect(buildVscodeUrl('/home/user/project')).toBe('vscode://file//home/user/project')
  })

  it('normalises Windows backslashes to forward slashes', () => {
    expect(buildVscodeUrl('C:\\Users\\me\\repo')).toBe('vscode://file/C:/Users/me/repo')
  })

  it('percent-encodes spaces and query/fragment delimiters so cwd cannot inject', () => {
    const url = buildVscodeUrl('/tmp/a b?x#y')
    expect(url).toBe('vscode://file//tmp/a%20b%3Fx%23y')
    // no raw ? or # survive into the URL past the fixed prefix
    expect(url!.slice('vscode://file/'.length)).not.toMatch(/[?#]/)
  })

  it('rejects control chars / newlines and empty input (non-vacuity)', () => {
    expect(buildVscodeUrl('')).toBeNull()
    expect(buildVscodeUrl('/tmp/a\nb')).toBeNull()
    expect(buildVscodeUrl('/tmp/a\tb')).toBeNull()
    expect(buildVscodeUrl(`/tmp/a${String.fromCharCode(0)}b`)).toBeNull()
    expect(buildVscodeUrl(`/tmp/a${String.fromCharCode(0x7f)}b`)).toBeNull()
  })
})
