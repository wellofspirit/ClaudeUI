/**
 * File extension → Prism language id.
 *
 * Extracted out of `CodeView.tsx` so the mapping is reachable without importing
 * a React component (and, through it, `prism-react-renderer`): the tool-card
 * chips, the Bash output detectors and the search body all need to name a
 * language from a path, and none of them render code. `CodeView` re-exports both
 * symbols, so every existing import site — and its tests — are unchanged.
 */

export const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  xml: 'markup',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  swift: 'swift',
  dockerfile: 'docker',
  makefile: 'makefile'
}

/** The Prism language for a path, or `'plaintext'` when the extension is unknown. */
export function getLang(filePath?: string): string {
  if (!filePath) return 'plaintext'
  // Split on BOTH separators — a Windows path has no `/` (RN11).
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() || ''
  // Handle extensionless files like Dockerfile, Makefile
  if (EXT_TO_LANG[name]) return EXT_TO_LANG[name]
  const ext = name.split('.').pop() || ''
  return EXT_TO_LANG[ext] || 'plaintext'
}
