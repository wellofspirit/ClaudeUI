import tailwindCss from '../assets/tailwind-full.css?raw'

/**
 * Injects bundled Tailwind CSS into an HTML document string.
 * Replaces the `<!-- tailwind:inject -->` placeholder with a <style> tag,
 * falls back to injecting into <head>, or prepends as last resort.
 */
export function buildSrcdoc(html: string, darkMode = false): string {
  const styleTag = `<style>${tailwindCss}</style>`
  let doc = html

  if (doc.includes('<!-- tailwind:inject -->')) {
    doc = doc.replace('<!-- tailwind:inject -->', styleTag)
  } else if (doc.includes('<head>')) {
    doc = doc.replace('<head>', `<head>${styleTag}`)
  } else {
    doc = styleTag + doc
  }

  if (darkMode) {
    doc = doc.replace('<html', '<html class="dark"')
  }

  return doc
}
