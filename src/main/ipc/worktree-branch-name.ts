import {
  assertBranchPrefixValid,
  getBranchPrefixIssue,
  normalizeBranchPrefix,
  selectBranchPrefixInput,
  type BranchPrefixSettings
} from '../../shared/branch-prefix'

/** Expose a normalized prefix so callers avoid double-prefixing and invalid slash combinations. */
export function getConfiguredBranchPrefix(
  settings: Parameters<typeof selectBranchPrefixInput>[0],
  gitUsername: string | null
): string | null {
  const raw = selectBranchPrefixInput(settings, gitUsername)
  return raw ? normalizeBranchPrefix(raw) || null : null
}

/** git check-ref-format rejects a ref ending in lowercase `.lock` (`.LOCK` is accepted); folders keep the name. */
function toRefLeaf(leaf: string): string {
  return leaf.replace(/\.lock$/, '-lock')
}

export function computeBranchName(
  sanitizedName: string,
  settings: Parameters<typeof selectBranchPrefixInput>[0],
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  const leaf = toRefLeaf(sanitizedName)
  return prefix ? `${prefix}/${leaf}` : leaf
}

/** Validate prefix settings early so creation errors identify configuration rather than opaque Git failures. */
export function computeValidatedBranchName(
  sanitizedName: string,
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  const leaf = toRefLeaf(sanitizedName)
  if (prefix === null) {
    return leaf
  }
  if (getBranchPrefixIssue(prefix) !== null) {
    // Git username lookup can return error payloads; skip invalid derived prefixes but reject custom ones.
    if (settings.branchPrefix === 'git-username') {
      return leaf
    }
    assertBranchPrefixValid(prefix)
  }
  return `${prefix}/${leaf}`
}
