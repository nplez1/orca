import type { Translate } from '@/i18n/use-translate'
import type {
  HostMeshMemberView,
  HostMeshSnapshot
} from '../../../../../../preload/api/host-mesh-api'
import type { HostMeshPairStatus } from '../../../../../../shared/host-mesh/host-mesh-contract'
import { HOST_MESH_MAX_MEMBERS } from '../../../../../../shared/host-mesh/host-mesh-contract'
import type { HostMeshGroupSummary } from '../../../../../../shared/host-mesh/host-mesh-membership'

/**
 * The panel's words, in one place.
 *
 * Why not in the component: the summary line and each member's row describe the same pairing state, and a
 * surface that says "one-way" at the top and "incomplete" on the row leaves the reader to guess.
 */

export type HostGroupMemberTone = 'statusSuccess' | 'statusWarning' | 'statusDanger'

export type HostGroupMemberStatus = {
  tone: HostGroupMemberTone
  label: string
  /** Why `half` gets a sentence and not just a tone: it is the state the panel exists to show. */
  detail: string | null
}

export function hostGroupMemberStatus(
  status: HostMeshPairStatus,
  t: Translate
): HostGroupMemberStatus {
  switch (status) {
    case 'complete':
      return {
        tone: 'statusSuccess',
        label: t('auto.components.settings.hostGroup.pairedBothWays', 'Paired both ways'),
        detail: null
      }
    case 'half':
      return {
        tone: 'statusWarning',
        label: t('auto.components.settings.hostGroup.oneWay', 'One-way'),
        detail: t(
          'auto.components.settings.hostGroup.oneWayDetail',
          'This computer and that one disagree about being paired: only one of them holds the pairing.'
        )
      }
    case 'missing':
      return {
        tone: 'statusDanger',
        label: t('auto.components.settings.hostGroup.notPaired', 'Not paired'),
        detail: t(
          'auto.components.settings.hostGroup.notPairedDetail',
          'Nothing pairs this computer with that one yet.'
        )
      }
  }
}

export function hostGroupSummaryLine(summary: HostMeshGroupSummary, t: Translate): string {
  const parts = [
    summary.memberCount === 1
      ? t('auto.components.settings.hostGroup.membersOne', '1 member')
      : t('auto.components.settings.hostGroup.membersMany', '{{count}} members', {
          count: summary.memberCount
        })
  ]
  if (summary.completePairs > 0) {
    parts.push(
      t('auto.components.settings.hostGroup.completePairs', '{{count}} paired both ways', {
        count: summary.completePairs
      })
    )
  }
  if (summary.halfPairs > 0) {
    parts.push(
      t('auto.components.settings.hostGroup.halfPairs', '{{count}} one-way', {
        count: summary.halfPairs
      })
    )
  }
  if (summary.missingPairs > 0) {
    parts.push(
      t('auto.components.settings.hostGroup.missingPairs', '{{count}} not paired', {
        count: summary.missingPairs
      })
    )
  }
  return parts.join(' · ')
}

export function hostGroupMemberDetail(
  member: HostMeshMemberView,
  members: readonly HostMeshMemberView[],
  t: Translate
): string | null {
  const parts: string[] = []
  if (member.introducedBy) {
    // Why a lookup with a fallback: the introducer can have left, and its key is still the honest answer.
    const introducer = members.find((other) => other.hostKey === member.introducedBy)
    parts.push(
      t('auto.components.settings.hostGroup.addedBy', 'Added by {{label}}', {
        label: introducer?.label ?? member.introducedBy
      })
    )
  }
  const { detail } = hostGroupMemberStatus(member.status, t)
  if (detail) {
    parts.push(detail)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

export function hostGroupCapacityNote(summary: HostMeshGroupSummary, t: Translate): string | null {
  return summary.atCap
    ? t('auto.components.settings.hostGroup.atCap', 'The group is full at {{count}} members.', {
        count: HOST_MESH_MAX_MEMBERS
      })
    : null
}

export function hostGroupGroupLine(snapshot: HostMeshSnapshot, t: Translate): string {
  return snapshot.inGroup
    ? t(
        'auto.components.settings.hostGroup.inGroup',
        'Every member is paired with this computer, so each host lists the same workspaces.'
      )
    : t(
        'auto.components.settings.hostGroup.notInGroup',
        'This computer is not in a group. Pair with a computer that is in one to join it.'
      )
}
