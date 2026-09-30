/**
 * opencode's auto-mode edit gate (ADR-084 §3): which targets an `edit` ask
 * names, and whether all of them are clear of agent-control paths. A wrong
 * "clear" is an unreviewed edit to `.git/config` or the agent's own settings.
 */
import { describe, it, expect } from 'vitest'
import {
  applyPatchMoveDestinations,
  editClearsAgentControl,
  opencodeEditTargets
} from '../agent-control-gate'

const PATCH_MOVE = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '*** Move to: .git/hooks/post-checkout',
  '@@',
  '-old',
  '+new',
  '*** End Patch'
].join('\n')

describe('applyPatchMoveDestinations', () => {
  it('reads every move directive', () => {
    expect(applyPatchMoveDestinations(PATCH_MOVE)).toEqual(['.git/hooks/post-checkout'])
    expect(
      applyPatchMoveDestinations(
        '*** Begin Patch\r\n*** Update File: a\r\n*** Move to: b\r\n*** Update File: c\r\n*** Move to: d\r\n*** End Patch'
      )
    ).toEqual(['b', 'd'])
  })

  it('reads more loosely than opencode parses (leading space, any case)', () => {
    expect(applyPatchMoveDestinations('  *** move TO: x/y')).toEqual(['x/y'])
  })

  it('no moves → empty; an empty destination → undeterminable', () => {
    expect(
      applyPatchMoveDestinations('*** Begin Patch\n*** Add File: a\n+x\n*** End Patch')
    ).toEqual([])
    expect(applyPatchMoveDestinations('*** Move to:   ')).toBeNull()
  })
})

describe('opencodeEditTargets', () => {
  it('edit/write: the patterns plus the tool path (input or metadata spelling)', () => {
    expect(opencodeEditTargets(['src/a.ts'], { filePath: '/r/src/a.ts' })).toEqual([
      'src/a.ts',
      '/r/src/a.ts'
    ])
    expect(opencodeEditTargets(['src/a.ts'], { filepath: '/r/src/a.ts', diff: '' })).toEqual([
      'src/a.ts',
      '/r/src/a.ts'
    ])
  })

  it('apply_patch from the tool input: move destinations from the patch text', () => {
    expect(opencodeEditTargets(['src/a.ts'], { patchText: PATCH_MOVE })).toEqual([
      'src/a.ts',
      '.git/hooks/post-checkout'
    ])
  })

  it('apply_patch from metadata: move destinations from files[].movePath', () => {
    expect(
      opencodeEditTargets(['src/a.ts', 'src/b.ts'], {
        filepath: 'src/a.ts, src/b.ts',
        files: [
          { filePath: '/r/src/a.ts', type: 'update' },
          { filePath: '/r/src/b.ts', movePath: '/r/.husky/pre-push', type: 'move' }
        ]
      })
    ).toEqual(['src/a.ts', 'src/b.ts', '/r/.husky/pre-push'])
  })

  it.each([
    ['no patterns', undefined, { filePath: 'a' }],
    ['empty patterns', [], { filePath: 'a' }],
    ['an input of no known shape', ['src/a.ts'], {}],
    ['a malformed files entry', ['src/a.ts'], { files: ['nope'] }],
    ['a non-string movePath', ['src/a.ts'], { files: [{ movePath: 7 }] }],
    ['an empty move destination', ['src/a.ts'], { patchText: '*** Move to: ' }]
  ])('%s → undeterminable (null)', (_label, patterns, input) => {
    expect(opencodeEditTargets(patterns, input as Record<string, unknown>)).toBeNull()
  })
})

describe('editClearsAgentControl', () => {
  it('an ordinary edit is clear', () => {
    expect(editClearsAgentControl(['src/a.ts'], { filePath: '/repo/src/a.ts' }, '/repo')).toBe(true)
  })

  it('a control path in any target is not', () => {
    expect(
      editClearsAgentControl(['.git/config'], { filePath: '/repo/.git/config' }, '/repo')
    ).toBe(false)
    // the move destination alone
    expect(editClearsAgentControl(['src/a.ts'], { patchText: PATCH_MOVE }, '/repo')).toBe(false)
    // case, on any host
    expect(editClearsAgentControl(['.GIT/config'], { filePath: '.GIT/config' }, '/repo')).toBe(
      false
    )
  })

  it('undeterminable targets are not clear', () => {
    expect(editClearsAgentControl(['src/a.ts'], {}, '/repo')).toBe(false)
    expect(editClearsAgentControl(undefined, { filePath: 'src/a.ts' }, '/repo')).toBe(false)
  })

  it('resolves against cwd: inside it relative, outside it absolute', () => {
    const wt = '/repo/.claude/worktrees/x'
    expect(editClearsAgentControl(['src/a.ts'], { filePath: `${wt}/src/a.ts` }, wt)).toBe(true)
    expect(
      editClearsAgentControl(
        ['../../settings.json'],
        { filePath: '/repo/.claude/settings.json' },
        wt
      )
    ).toBe(false)
    expect(
      editClearsAgentControl(['../outside/.claude/settings.json'], { filePath: 'x' }, '/repo')
    ).toBe(false)
  })

  it('Windows cwd: native separators and other-drive absolute patterns', () => {
    expect(
      editClearsAgentControl(['src\\a.ts'], { filePath: 'D:\\repo\\src\\a.ts' }, 'D:\\repo')
    ).toBe(true)
    expect(
      editClearsAgentControl(
        ['E:\\x\\.claude\\settings.json'],
        { filePath: 'E:\\x\\.claude\\settings.json' },
        'D:\\repo'
      )
    ).toBe(false)
  })
})
