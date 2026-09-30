/**
 * @vitest-environment node
 *
 * Launch specs (ADR-082 §2): `withLaunch` is the one place a harness argv is
 * composed, so a native launch must reproduce today's argv exactly and a
 * Node-script launch must put the script before the site's arguments.
 */
import { describe, it, expect } from 'vitest'
import { nativeLaunch, nodeScriptLaunch, toLaunch, withLaunch } from '../launch'

describe('launch specs', () => {
  it('a native launch is the executable with no leading args or env', () => {
    expect(nativeLaunch('/bin/opencode')).toEqual({ command: '/bin/opencode', args: [] })
    expect(toLaunch('/bin/pi')).toEqual({ command: '/bin/pi', args: [] })
    const launch = nodeScriptLaunch('/usr/bin/node', '/pkg/cli.js')
    expect(toLaunch(launch)).toBe(launch)
  })

  it('a node-script launch runs the script under node, with env only when given', () => {
    expect(nodeScriptLaunch('/usr/bin/node', '/pkg/cli.js')).toEqual({
      command: '/usr/bin/node',
      args: ['/pkg/cli.js']
    })
    expect(nodeScriptLaunch('/app/electron', '/pkg/cli.js', { ELECTRON_RUN_AS_NODE: '1' })).toEqual(
      {
        command: '/app/electron',
        args: ['/pkg/cli.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    )
  })
})

describe('withLaunch', () => {
  it('leaves a native argv and env untouched', () => {
    const siteEnv = { PATH: '/bin', X: '1' }
    const composed = withLaunch(nativeLaunch('/bin/pi'), ['--mode', 'rpc'], siteEnv)
    expect(composed).toEqual({ command: '/bin/pi', args: ['--mode', 'rpc'], env: siteEnv })
    // The same object: a site with replacement semantics (Codex) sees no copy.
    expect(composed.env).toBe(siteEnv)
  })

  it('omits env when neither side has one, so spawn inherits', () => {
    expect(withLaunch(nativeLaunch('/bin/pi'), ['-v'])).toEqual({
      command: '/bin/pi',
      args: ['-v']
    })
  })

  it('prepends the launch args before the site args', () => {
    expect(
      withLaunch(nodeScriptLaunch('/usr/bin/node', '/pkg/cli.js'), ['--mode', 'rpc']).args
    ).toEqual(['/pkg/cli.js', '--mode', 'rpc'])
  })

  it('lays the launch env over the site env', () => {
    const launch = nodeScriptLaunch('/app/electron', '/pkg/cli.js', {
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/pi-node/bin'
    })
    const composed = withLaunch(launch, ['--version'], { PATH: '/bin', KEEP: 'yes' })
    expect(composed).toEqual({
      command: '/app/electron',
      args: ['/pkg/cli.js', '--version'],
      env: { PATH: '/pi-node/bin', KEEP: 'yes', ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(withLaunch(launch, []).env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/pi-node/bin'
    })
  })

  it('never mutates the launch it was given', () => {
    const launch = nodeScriptLaunch('/usr/bin/node', '/pkg/cli.js')
    withLaunch(launch, ['a']).args.push('b')
    expect(launch.args).toEqual(['/pkg/cli.js'])
  })
})
