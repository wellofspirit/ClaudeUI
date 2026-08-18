/**
 * `claudeui-server` argument parsing (S3 stage 2).
 *
 * The surface is small on purpose, so the tests pin the DECISIONS rather than
 * the mechanics — in particular the two places where "absent" and "false" are
 * different answers, which is where a flag parser silently changes a
 * deployment's posture.
 */

import { describe, it, expect } from 'vitest'
import { CliError, HELP_TEXT, parseServerArgs } from '../cli'

describe('parseServerArgs', () => {
  it('defaults to serve with nothing set', () => {
    expect(parseServerArgs([])).toEqual({
      command: 'serve',
      port: undefined,
      bind: undefined,
      tls: undefined,
      disableAuth: false
    })
  })

  it('accepts an explicit serve command', () => {
    expect(parseServerArgs(['serve']).command).toBe('serve')
  })

  it('parses show-link', () => {
    expect(parseServerArgs(['show-link']).command).toBe('show-link')
  })

  it('rejects an unknown command with actionable text', () => {
    expect(() => parseServerArgs(['sevre'])).toThrow(CliError)
    expect(() => parseServerArgs(['sevre'])).toThrow(/Unknown command "sevre".*--help/s)
  })

  it('parses port and bind, long and short', () => {
    expect(parseServerArgs(['--port', '8080', '--bind', '0.0.0.0'])).toMatchObject({
      port: 8080,
      bind: '0.0.0.0'
    })
    expect(parseServerArgs(['-p', '9000', '-b', '127.0.0.1'])).toMatchObject({
      port: 9000,
      bind: '127.0.0.1'
    })
  })

  it('accepts port 0 as "let the OS pick"', () => {
    expect(parseServerArgs(['--port', '0']).port).toBe(0)
  })

  it('rejects a privileged port, matching remote:set-config exactly', () => {
    // ONE rule, both host surfaces — the console must not be able to configure
    // something the desktop's writer would refuse.
    expect(() => parseServerArgs(['--port', '80'])).toThrow(
      /0 \(random\) or between 1024 and 65535/
    )
  })

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => parseServerArgs(['--port', 'http'])).toThrow(CliError)
    expect(() => parseServerArgs(['--port', '70000'])).toThrow(CliError)
    expect(() => parseServerArgs(['--port', '8080.5'])).toThrow(CliError)
  })

  it('rejects an empty --bind', () => {
    expect(() => parseServerArgs(['--bind', '   '])).toThrow(/requires an address/)
  })

  it('leaves tls UNDEFINED when the flag is absent, not false', () => {
    // The distinction is load-bearing: `undefined` means "leave the persisted
    // tlsMode alone". If an absent flag parsed as `false`, every restart without
    // --tls would silently turn TLS off for a server configured to use it.
    expect(parseServerArgs([]).tls).toBeUndefined()
    expect(parseServerArgs(['--tls']).tls).toBe(true)
  })

  it('parses --disable-auth as a plain boolean', () => {
    expect(parseServerArgs([]).disableAuth).toBe(false)
    expect(parseServerArgs(['--disable-auth']).disableAuth).toBe(true)
  })

  it('treats --help and the help command as the same thing', () => {
    expect(parseServerArgs(['--help']).command).toBe('help')
    expect(parseServerArgs(['-h']).command).toBe('help')
    expect(parseServerArgs(['help']).command).toBe('help')
    // --help wins over any other flag, so a malformed invocation can still ask
    // for the usage text.
    expect(parseServerArgs(['show-link', '--help']).command).toBe('help')
  })

  it('rejects an unknown option rather than ignoring it', () => {
    // Fail-closed: a typo'd security flag that parses to "not set" is how a
    // server ends up in a posture nobody chose.
    expect(() => parseServerArgs(['--disable-authh'])).toThrow(CliError)
    expect(() => parseServerArgs(['--no-auth'])).toThrow(CliError)
  })

  it('rejects stray positionals', () => {
    expect(() => parseServerArgs(['serve', 'extra'])).toThrow(CliError)
  })

  it('documents every flag it accepts', () => {
    // A flag that exists but is undocumented is a flag nobody will use
    // correctly. Cheap guard, catches the copy-paste omission.
    for (const flag of ['--port', '--bind', '--tls', '--disable-auth', '--help', 'show-link']) {
      expect(HELP_TEXT).toContain(flag)
    }
  })

  it('warns in the help text that --disable-auth is total', () => {
    // Whitespace-normalised: the assertion is about the WARNING being present,
    // not about where the help text happens to wrap.
    expect(HELP_TEXT.replace(/\s+/g, ' ')).toMatch(/operator-level access to this machine/)
  })
})
