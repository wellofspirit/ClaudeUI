/** Keep the typed request recoverable from native thread history. */
const PREFIX = '<!-- claudeui-skill-input:'

export function withOriginalSkillInput(original: string, expanded: string): string {
  return `${PREFIX}${Buffer.from(original, 'utf8').toString('base64')} -->\n${expanded}`
}

export function originalSkillInput(text: string): string {
  if (!text.startsWith(PREFIX)) return text
  const end = text.indexOf(' -->\n', PREFIX.length)
  if (end < 0 || end > PREFIX.length + 1024 * 1024) return text
  const encoded = text.slice(PREFIX.length, end)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return text
  return Buffer.from(encoded, 'base64').toString('utf8')
}
