const invalidWin32Characters = new Set(['<', '>', ':', '"', '|', '?', '*'])
const reservedWin32Basename = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/i

/** Accepts only relative paths with identical, ordinary-file meaning on supported platforms. */
export function isPortableRelativeEvaluationPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) return false

  const components = path.split('/')
  return components.every((component) => {
    if (
      component.length === 0 ||
      component === '.' ||
      component === '..' ||
      component.endsWith('.') ||
      component.endsWith(' ')
    ) {
      return false
    }
    for (const character of component) {
      if (character.charCodeAt(0) <= 31 || invalidWin32Characters.has(character)) return false
    }
    const basename = component.split('.', 1)[0]!
    return !reservedWin32Basename.test(basename)
  })
}
