import { normalizeRelativePath } from '@/lib/path'
import { pathMatchesFileNameFilterTokens } from '../../../../shared/file-name-filter-tokens'
import { isDotfileRelativePath } from './file-explorer-entries'
import { isPathIgnored } from './status-display'
import type { FileExplorerNameFilterProjectionSource } from './file-explorer-name-filter-policy'

export type AcceptedNameFilterPath = {
  relativePath: string
}

export function getAcceptedNameFilterPath(args: {
  rawRelativePath: string
  nameFilter: FileExplorerNameFilterProjectionSource
  nameFilterTokens: readonly string[]
  hostAppliedScope: boolean
  ignoredSet: Set<string>
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
}): AcceptedNameFilterPath | null {
  if (
    !args.rawRelativePath ||
    args.rawRelativePath.startsWith('/') ||
    args.rawRelativePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(args.rawRelativePath)
  ) {
    return null
  }
  const requiresNormalization =
    args.rawRelativePath.includes('\\') || args.rawRelativePath.includes('//')
  const relativePath = requiresNormalization
    ? normalizeRelativePath(args.rawRelativePath)
    : args.rawRelativePath
  if (!isSafeNormalizedRelativePath(relativePath)) {
    return null
  }
  if (!args.hostAppliedScope && !args.showDotfiles && isDotfileRelativePath(relativePath)) {
    return null
  }
  if (
    !args.hostAppliedScope &&
    !args.showGitIgnoredFiles &&
    isPathIgnored(args.ignoredSet, relativePath)
  ) {
    return null
  }
  return !args.hostAppliedScope &&
    !pathMatchesFileNameFilterTokens(relativePath, args.nameFilterTokens)
    ? null
    : { relativePath }
}

function isSafeNormalizedRelativePath(relativePath: string): boolean {
  let segmentStart = 0
  for (let index = 0; index <= relativePath.length; index += 1) {
    if (index < relativePath.length && relativePath.charCodeAt(index) !== 47) {
      continue
    }
    const segmentLength = index - segmentStart
    if (
      segmentLength === 0 ||
      (segmentLength === 1 && relativePath.charCodeAt(segmentStart) === 46) ||
      (segmentLength === 2 &&
        relativePath.charCodeAt(segmentStart) === 46 &&
        relativePath.charCodeAt(segmentStart + 1) === 46)
    ) {
      return false
    }
    segmentStart = index + 1
  }
  return relativePath.length > 0
}
