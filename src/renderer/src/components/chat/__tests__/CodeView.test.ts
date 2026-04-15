/**
 * Layer 1: Unit tests for pure utility functions in CodeView.tsx.
 *
 * Tests stripLineNumbers, getStartLine, and the EXT_TO_LANG mapping.
 * No rendering, no DOM — pure string/map logic only.
 */

import { describe, it, expect } from 'vitest'
import { stripLineNumbers, getStartLine, EXT_TO_LANG } from '../CodeView'

describe('stripLineNumbers', () => {
  it('stripLineNumbers_standardCatNOutput_removesAllPrefixes', () => {
    const input = '     1→hello\n     2→world'
    expect(stripLineNumbers(input)).toBe('hello\nworld')
  })

  it('stripLineNumbers_noLineNumbers_returnsUnchanged', () => {
    const input = 'plain text\nno prefixes here'
    expect(stripLineNumbers(input)).toBe('plain text\nno prefixes here')
  })

  it('stripLineNumbers_mixedLines_onlyStripsLinesWithPrefix', () => {
    // Some lines have the prefix, some don't — only strip the prefixed ones
    const input = '     1→with prefix\nwithout prefix\n     3→also with prefix'
    expect(stripLineNumbers(input)).toBe('with prefix\nwithout prefix\nalso with prefix')
  })

  it('stripLineNumbers_largeLineNumbers_handlesMultipleDigits', () => {
    const input = '   100→code line\n  1000→another line'
    expect(stripLineNumbers(input)).toBe('code line\nanother line')
  })

  it('stripLineNumbers_emptyString_returnsEmpty', () => {
    expect(stripLineNumbers('')).toBe('')
  })

  it('stripLineNumbers_singleLine_stripsCorrectly', () => {
    expect(stripLineNumbers('        5→const x = 1')).toBe('const x = 1')
  })

  it('stripLineNumbers_contentWithArrow_onlyStripsLeadingPrefixes', () => {
    // Arrow in the content itself (not a prefix) must not be stripped
    const input = '     1→a→b'
    expect(stripLineNumbers(input)).toBe('a→b')
  })
})

describe('getStartLine', () => {
  it('getStartLine_firstLineIsOne_returnsOne', () => {
    expect(getStartLine('     1→hello')).toBe(1)
  })

  it('getStartLine_startingAtLineN_returnsN', () => {
    expect(getStartLine('    50→some code\n    51→more code')).toBe(50)
  })

  it('getStartLine_noLineNumbers_defaultsToOne', () => {
    expect(getStartLine('plain text with no prefix')).toBe(1)
  })

  it('getStartLine_emptyString_defaultsToOne', () => {
    expect(getStartLine('')).toBe(1)
  })

  it('getStartLine_largeStartLine_parsesCorrectly', () => {
    expect(getStartLine('  1234→deeply nested file')).toBe(1234)
  })

  it('getStartLine_usesFirstLinePrefixOnly_ignoresSubsequentLines', () => {
    // Only the first match matters (non-global regex)
    expect(getStartLine('    10→first\n    20→second')).toBe(10)
  })
})

describe('EXT_TO_LANG', () => {
  it('EXT_TO_LANG_typescript_mapsToTypescript', () => {
    expect(EXT_TO_LANG['ts']).toBe('typescript')
  })

  it('EXT_TO_LANG_tsx_mapsToTsx', () => {
    expect(EXT_TO_LANG['tsx']).toBe('tsx')
  })

  it('EXT_TO_LANG_javascript_mapsToJavascript', () => {
    expect(EXT_TO_LANG['js']).toBe('javascript')
  })

  it('EXT_TO_LANG_jsx_mapsToJsx', () => {
    expect(EXT_TO_LANG['jsx']).toBe('jsx')
  })

  it('EXT_TO_LANG_python_mapsToPython', () => {
    expect(EXT_TO_LANG['py']).toBe('python')
  })

  it('EXT_TO_LANG_ruby_mapsToRuby', () => {
    expect(EXT_TO_LANG['rb']).toBe('ruby')
  })

  it('EXT_TO_LANG_rust_mapsToRust', () => {
    expect(EXT_TO_LANG['rs']).toBe('rust')
  })

  it('EXT_TO_LANG_go_mapsToGo', () => {
    expect(EXT_TO_LANG['go']).toBe('go')
  })

  it('EXT_TO_LANG_java_mapsToJava', () => {
    expect(EXT_TO_LANG['java']).toBe('java')
  })

  it('EXT_TO_LANG_csharp_mapsToCsharp', () => {
    expect(EXT_TO_LANG['cs']).toBe('csharp')
  })

  it('EXT_TO_LANG_css_mapsToCss', () => {
    expect(EXT_TO_LANG['css']).toBe('css')
  })

  it('EXT_TO_LANG_json_mapsToJson', () => {
    expect(EXT_TO_LANG['json']).toBe('json')
  })

  it('EXT_TO_LANG_yaml_mapsToYaml', () => {
    expect(EXT_TO_LANG['yaml']).toBe('yaml')
    expect(EXT_TO_LANG['yml']).toBe('yaml')
  })

  it('EXT_TO_LANG_shell_mapsToBash', () => {
    expect(EXT_TO_LANG['sh']).toBe('bash')
    expect(EXT_TO_LANG['bash']).toBe('bash')
    expect(EXT_TO_LANG['zsh']).toBe('bash')
  })

  it('EXT_TO_LANG_markdown_mapsToMarkdown', () => {
    expect(EXT_TO_LANG['md']).toBe('markdown')
  })

  it('EXT_TO_LANG_html_mapsToMarkup', () => {
    expect(EXT_TO_LANG['html']).toBe('markup')
    expect(EXT_TO_LANG['xml']).toBe('markup')
  })

  it('EXT_TO_LANG_mjs_mapsToJavascript', () => {
    expect(EXT_TO_LANG['mjs']).toBe('javascript')
    expect(EXT_TO_LANG['cjs']).toBe('javascript')
  })

  it('EXT_TO_LANG_headerFiles_mapToCOrCpp', () => {
    expect(EXT_TO_LANG['h']).toBe('c')
    expect(EXT_TO_LANG['hpp']).toBe('cpp')
  })
})
