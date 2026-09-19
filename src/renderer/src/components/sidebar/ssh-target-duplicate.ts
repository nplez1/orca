import { normalizeSshConfigAlias } from '../../../../shared/ssh-config-alias'
import type { SshTarget } from '../../../../shared/ssh-types'

/** Alias-owning fields, plus visibility when the caller has the full row. */
type SshTargetAliasCandidate = Pick<SshTarget, 'configHost' | 'label' | 'host'> &
  Partial<Pick<SshTarget, 'hidden'>>

/** True when an existing Orca host already owns this config alias / label. */
export function isDuplicateSshTargetAlias(args: {
  existingTargets: readonly SshTargetAliasCandidate[]
  configHost: string
  label: string
  host: string
}): boolean {
  return findDuplicateSshTargetAlias(args) !== null
}

/** The existing host that owns this alias, so the caller can say whether it is hidden. */
export function findDuplicateSshTargetAlias({
  existingTargets,
  configHost,
  label,
  host
}: {
  existingTargets: readonly SshTargetAliasCandidate[]
  configHost: string
  label: string
  host: string
}): SshTargetAliasCandidate | null {
  // Why: the config picker's `alreadyInOrca` flag compares lowercased aliases; match it or the
  // two checks disagree on case-only variants.
  const alias =
    normalizeSshConfigAlias(configHost) ||
    normalizeSshConfigAlias(label) ||
    normalizeSshConfigAlias(host)
  if (!alias) {
    return null
  }
  return existingTargets.find((target) => getOccupiedAliases(target).includes(alias)) ?? null
}

/** Why: the picker treats configHost *and* label as owned, so the save check must too —
 *  otherwise an alias it greys out as "In Orca" is still savable as a second target. */
function getOccupiedAliases(target: Pick<SshTarget, 'configHost' | 'label' | 'host'>): string[] {
  const occupied = [target.configHost, target.label].map(normalizeSshConfigAlias).filter(Boolean)
  return occupied.length > 0 ? occupied : [normalizeSshConfigAlias(target.host)].filter(Boolean)
}
