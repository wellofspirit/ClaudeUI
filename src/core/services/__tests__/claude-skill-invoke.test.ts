/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { ClaudeSkillCatalog, ClaudeSkillEntry } from '../claude-skill-catalog'
import {
  expandClaudeSkillInvocation,
  parseSkillInvocation,
  parseSkillInvocationEnvelope,
  type SkillInvocation
} from '../claude-skill-invoke'

const make = (over: Partial<ClaudeSkillEntry>): ClaudeSkillEntry => ({
  name: 'greet',
  kind: 'skill',
  source: 'user',
  file: '/cfg/skills/greet/SKILL.md',
  description: 'd',
  argumentNames: [],
  body: 'Hello',
  userInvocable: true,
  modelInvocable: true,
  claudeOnly: [],
  ...over
})
const cat = (...entries: ClaudeSkillEntry[]): ClaudeSkillCatalog => ({ entries, skipped: [] })
const expand = (
  entry: Partial<ClaudeSkillEntry>,
  args = '',
  ctx: { cwd?: string; sessionId?: string } = {}
): string =>
  expandClaudeSkillInvocation({ entry: make(entry), args }, { cwd: '/work/proj', ...ctx })
/** The expansion without the envelope. */
const bodyOf = (text: string): string => text.slice(text.indexOf('\n\n') + 2)

describe('parseSkillInvocation', () => {
  const c = cat(
    make({ name: 'greet' }),
    make({ name: 'p:thing', aliases: ['thing'] }),
    make({ name: 'hidden', userInvocable: false })
  )

  it('matches a name or alias followed by whitespace or the end, trimming the args', () => {
    expect(parseSkillInvocation('/greet', c)).toMatchObject({ args: '' })
    expect(parseSkillInvocation('/greet   a b  ', c)).toMatchObject({ args: 'a b' })
    expect(parseSkillInvocation('/greet\nline1\nline2', c)?.args).toBe('line1\nline2')
    expect(parseSkillInvocation('/p:thing x', c)?.entry.name).toBe('p:thing')
    expect(parseSkillInvocation('/thing x', c)?.entry.name).toBe('p:thing')
  })

  it('does not match a prefix, a non-leading slash, an unknown or a non-user-invocable name', () => {
    expect(parseSkillInvocation('/greeting', c)).toBeNull()
    expect(parseSkillInvocation(' /greet', c)).toBeNull()
    expect(parseSkillInvocation('please /greet', c)).toBeNull()
    expect(parseSkillInvocation('/nope', c)).toBeNull()
    expect(parseSkillInvocation('/hidden', c)).toBeNull()
    expect(parseSkillInvocation('/', c)).toBeNull()
  })
})

describe('expandClaudeSkillInvocation', () => {
  it('writes the envelope, omitting the args line when there are none', () => {
    expect(expand({ body: 'B' })).toBe(
      '<command-message>greet</command-message>\n<command-name>/greet</command-name>\n\nB'
    )
    expect(expand({ body: 'B ${x}' }, 'a b')).toBe(
      '<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>a b</command-args>\n\nB ${x}\n\nARGUMENTS: a b'
    )
  })

  it('prefixes the base-directory header only for entries with a baseDir', () => {
    expect(bodyOf(expand({ baseDir: '/cfg/skills/greet', body: 'B' }))).toBe(
      'Base directory for this skill: /cfg/skills/greet\n\nB'
    )
    expect(bodyOf(expand({ body: 'B' }))).toBe('B')
  })

  it('fills the CLAUDE_* variables, leaving unknown ones and a missing session id as written', () => {
    const text = bodyOf(
      expand(
        {
          baseDir: '/s',
          pluginRoot: '/p',
          body: '${CLAUDE_SKILL_DIR} ${CLAUDE_PROJECT_DIR} ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT} ${CLAUDE_PLUGIN_ROOT}'
        },
        '',
        { sessionId: 'sid' }
      )
    )
    expect(text).toContain('/s /work/proj sid ${CLAUDE_EFFORT} /p')
    expect(bodyOf(expand({ body: '${CLAUDE_SESSION_ID}' }))).toBe('${CLAUDE_SESSION_ID}')
  })

  it('substitutes $ARGUMENTS, $n (zero-based), $ARGUMENTS[n] and named arguments', () => {
    const entry = {
      argumentNames: ['first', 'second'],
      body: 'A=$ARGUMENTS 0=$0 1=$1 i=$ARGUMENTS[1] f=$first s=$second'
    }
    expect(bodyOf(expand(entry, 'x "y z"'))).toBe('A=x "y z" 0=x 1=y z i=y z f=x s=y z')
  })

  it('prefers the longest name, and a name followed by [ or a word char is not a placeholder', () => {
    const entry = { argumentNames: ['a', 'ab'], body: '$ab $a $abc $a[0]' }
    expect(bodyOf(expand(entry, 'one two'))).toBe('two one $abc $a[0]')
  })

  it('leaves a missing index or position as written and does not count it as a match', () => {
    expect(bodyOf(expand({ body: '$5 $ARGUMENTS[7] $x1' }, 'a'))).toBe(
      '$5 $ARGUMENTS[7] $x1\n\nARGUMENTS: a'
    )
  })

  it('makes \\$ literal and does not count it as a match', () => {
    expect(bodyOf(expand({ body: 'cost \\$ARGUMENTS and \\$0' }, 'a'))).toBe(
      'cost $ARGUMENTS and $0\n\nARGUMENTS: a'
    )
    // an escaped backslash does not escape the dollar
    expect(bodyOf(expand({ body: '\\\\$0' }, 'a'))).toBe('\\\\a')
  })

  it('appends ARGUMENTS only when args are non-empty and nothing matched', () => {
    expect(bodyOf(expand({ body: 'plain' }, 'a b'))).toBe('plain\n\nARGUMENTS: a b')
    expect(bodyOf(expand({ body: 'plain' }))).toBe('plain')
    expect(bodyOf(expand({ body: 'uses $ARGUMENTS' }, 'a b'))).toBe('uses a b')
  })

  it('splits bash-style, falling back to whitespace on an open quote', () => {
    expect(bodyOf(expand({ body: '[$0|$1|$2]' }, `'a b' c\\ d "e \\" f"`))).toBe('[a b|c d|e " f]')
    expect(bodyOf(expand({ body: '[$0|$1]' }, `"open a`))).toBe('["open|a]')
  })

  it('escapes substituted values so they cannot form a shell marker', () => {
    expect(bodyOf(expand({ body: 'x $ARGUMENTS y' }, '`!ls !`'))).toBe('x ` !ls ! ` y')
    expect(bodyOf(expand({ body: '$0' }, '!rm'))).toBe('\\!rm')
    expect(bodyOf(expand({ body: 'plain' }, '!rm'))).toBe('plain\n\nARGUMENTS: \\!rm')
  })

  it('does not rescan a substituted value for placeholders', () => {
    expect(bodyOf(expand({ body: '$0 $1' }, '$1 b'))).toBe('$1 b')
  })

  it('turns every inline and fenced shell command into a note, running nothing', () => {
    const note = (c: string): string =>
      `[ClaudeUI did not run this skill command; run it yourself if you need its output: \`${c}\`]`
    const out = bodyOf(
      expand({ body: 'branch: !`git branch --show-current`\n```!\nnpm test\n```\nnot!`x`' })
    )
    expect(out).toBe(`branch: ${note('git branch --show-current')}\n${note('npm test')}\nnot!\`x\``)
  })
})

describe('parseSkillInvocationEnvelope', () => {
  const roundTrip = (
    invocation: SkillInvocation
  ): ReturnType<typeof parseSkillInvocationEnvelope> =>
    parseSkillInvocationEnvelope(expandClaudeSkillInvocation(invocation, { cwd: '/w' }))

  it('round-trips the typed command with and without args', () => {
    const entry = make({ name: 'p:thing', body: 'x $ARGUMENTS' })
    expect(roundTrip({ entry, args: 'a\nb' })).toEqual({
      commandName: '/p:thing',
      commandArgs: 'a\nb'
    })
    expect(roundTrip({ entry, args: '' })).toEqual({ commandName: '/p:thing' })
  })

  it('round-trips through parseSkillInvocation', () => {
    const c = cat(make({ name: 'greet' }))
    const inv = parseSkillInvocation('/greet  hi there ', c)!
    expect(roundTrip(inv)).toEqual({ commandName: '/greet', commandArgs: 'hi there' })
  })

  it('rejects ordinary text and text that merely mentions the tags', () => {
    expect(parseSkillInvocationEnvelope('hello')).toBeNull()
    expect(parseSkillInvocationEnvelope('/greet a')).toBeNull()
    expect(
      parseSkillInvocationEnvelope('see <command-name>/greet</command-name> in the docs')
    ).toBeNull()
  })
})
