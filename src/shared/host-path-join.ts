/** Host filesystem paths arrive as strings from both POSIX and Windows machines, so joining keeps
 *  whichever separator the path already uses instead of assuming this process's. */

export function hostPathSeparatorFor(pathValue: string): '/' | '\\' {
  return pathValue.includes('\\') ? '\\' : '/'
}

export function trimHostPathSeparators(pathValue: string): string {
  const trimmed = pathValue.replace(/[\\/]+$/, '')
  if (trimmed === '' && pathValue.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}${hostPathSeparatorFor(pathValue)}`
  }
  return trimmed
}

export function joinHostPath(parentPath: string, childName: string): string {
  const parent = trimHostPathSeparators(parentPath.trim())
  const child = childName.trim().replace(/^[\\/]+/, '')
  if (!parent || !child) {
    return parent || child
  }
  const separator = hostPathSeparatorFor(parent)
  if (parent === '/' || /^[A-Za-z]:[\\/]$/.test(parent)) {
    return `${parent}${child}`
  }
  return `${parent}${separator}${child}`
}
