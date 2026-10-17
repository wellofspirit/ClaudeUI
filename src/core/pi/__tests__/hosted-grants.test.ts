/**
 * @vitest-environment node
 *
 * The one-shot `/hosted-tool` grants (SECURITY, A1) and, since the session tools, whose
 * call each grant was minted for.
 */
import { describe, expect, it } from 'vitest'
import { HostedGrants, MAX_HOSTED_GRANTS } from '../hosted-grants'

describe('HostedGrants', () => {
  it('a grant is one-shot and bound to its exact id and tool name', () => {
    const grants = new HostedGrants()
    grants.mint('c1', 'session_list')
    expect(grants.consume('c1', 'session_stop')).toBe(false)
    expect(grants.consume('c1', 'session_list')).toBe(true)
    expect(grants.consume('c1', 'session_list')).toBe(false)
  })

  it('says whose call it was minted for: the root agent by default, a subagent when told', () => {
    const grants = new HostedGrants()
    grants.mint('root-call', 'session_list')
    grants.mint('child-call', 'session_list', 'subagent')
    expect(grants.consumeOwner('root-call', 'session_list')).toBe('root')
    expect(grants.consumeOwner('child-call', 'session_list')).toBe('subagent')
    // Consumed once, whoever it was for; a mismatch or an absent grant is null, never a default owner.
    expect(grants.consumeOwner('child-call', 'session_list')).toBeNull()
    grants.mint('c2', 'session_list', 'subagent')
    expect(grants.consumeOwner('c2', 'session_stop')).toBeNull()
    expect(grants.consumeOwner('nobody', 'session_list')).toBeNull()
  })

  it('a withheld (abandoned) mint, eviction and clear still apply', () => {
    const grants = new HostedGrants()
    grants.abandon('late')
    expect(grants.mint('late', 'session_list')).toBe(false)
    expect(grants.consumeOwner('late', 'session_list')).toBeNull()
    for (let i = 0; i <= MAX_HOSTED_GRANTS; i++) grants.mint(`c${i}`, 'session_list')
    expect(grants.consumeOwner('c0', 'session_list')).toBeNull()
    expect(grants.consumeOwner(`c${MAX_HOSTED_GRANTS}`, 'session_list')).toBe('root')
    grants.mint('x', 'session_list')
    grants.clear()
    expect(grants.consume('x', 'session_list')).toBe(false)
  })
})
