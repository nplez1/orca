import { isPathInsideOrEqual } from '../../../../../../shared/file-access/cross-platform-path'
import { dirname } from '@/lib/path'

export type FileExplorerMoveDestination = 'allowed' | 'same-folder' | 'inside-source'

/** A folder moved into its own subtree would detach it; a same-folder move is a no-op. */
export function classifyMoveDestination(
  sourcePath: string,
  destDir: string
): FileExplorerMoveDestination {
  if (isPathInsideOrEqual(sourcePath, destDir)) {
    return 'inside-source'
  }
  const sourceDir = dirname(sourcePath)
  return isPathInsideOrEqual(sourceDir, destDir) && isPathInsideOrEqual(destDir, sourceDir)
    ? 'same-folder'
    : 'allowed'
}

/** Moving a folder already carries everything selected inside it; moving those too would fail after it. */
export function outermostPaths(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => !paths.some((other) => other !== path && isPathInsideOrEqual(other, path))
  )
}

/** Keeps the name when the destination differs, then follows Duplicate's "name copy", "name copy 2" sequence. */
export function* copyNameCandidates(name: string, keepName: boolean): Generator<string, never> {
  if (keepName) {
    yield name
  }
  const dotIndex = name.lastIndexOf('.')
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ''
  yield `${stem} copy${ext}`
  for (let n = 2; ; n += 1) {
    yield `${stem} copy ${n}${ext}`
  }
}
