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
    case 'needsUpdate':
      return {
        tone: 'statusWarning',
        label: t('auto.components.settings.hostGroup.needsUpdate', 'Needs update'),
        detail: t(
          'auto.components.settings.hostGroup.needsUpdateDetail',
          'This computer answers, but it is running a version without the mesh. It joins as soon as it updates.'
        )
      }
    case 'half':
      return {
        tone: 'statusWarning',
        label: t('auto.components.settings.hostGroup.oneWay', 'One-way'),
        detail: t(
          'auto.components.settings.hostGroup.oneWayDetail',
          'This computer and that one disagree about being paired: only one of them holds the pairing. This computer keeps retrying on its own.'
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

/**
 * Where the group came from, when an upgrade made it.
 *
 * Why the pane says this: the group appears without the owner creating it, so the first question it has to
 * answer is "why is this here?". Absent when the owner made the group themselves.
 */
export function hostGroupMigrationLine(
  migration: { peerCount: number } | null,
  t: Translate
): string | null {
  if (migration === null || migration.peerCount === 0) {
    return null
  }
  return migration.peerCount === 1
    ? t(
        'auto.components.settings.hostGroup.migratedOne',
        'Created when this version arrived, from the computer this one was already paired with.'
      )
    : t(
        'auto.components.settings.hostGroup.migratedMany',
        'Created when this version arrived, from the {{count}} computers this one was already paired with.',
        { count: migration.peerCount }
      )
}

/**
 * Why the pane states the cadence instead of offering a button: the mesh reconciles itself in the main process, so a
 * Sync control would ask for something already happening — and imply the automatic path does not exist.
 */
export function hostGroupAutoSyncLine(
  snapshot: HostMeshSnapshot,
  t: Translate,
  now = Date.now()
): string | null {
  if (!snapshot.settings.enabled) {
    return null
  }
  if (snapshot.lastSyncedAt === null) {
    return t(
      'auto.components.settings.hostGroup.autoSyncFirst',
      'Checks itself on its own, and whenever a computer appears.'
    )
  }
  const minutes = Math.max(0, Math.floor((now - snapshot.lastSyncedAt) / 60_000))
  return minutes < 1
    ? t('auto.components.settings.hostGroup.autoSyncJustNow', 'Kept current · checked just now')
    : t(
        'auto.components.settings.hostGroup.autoSyncMinutes',
        'Kept current · checked {{count}}m ago',
        {
          count: minutes
        }
      )
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
    ? t('auto.components.settings.hostGroup.atCap', 'The mesh is full at {{count}} members.', {
        count: HOST_MESH_MAX_MEMBERS
      })
    : null
}

export function hostGroupGroupLine(
  settings: { enabled: boolean },
  snapshot: HostMeshSnapshot | null,
  t: Translate
): string {
  if (!settings.enabled) {
    return t(
      'auto.components.settings.hostGroup.meshOff',
      'Mesh mode is off. This computer keeps only the pairings you make yourself.'
    )
  }
  if (snapshot === null || !snapshot.inGroup) {
    return t(
      'auto.components.settings.hostGroup.notInGroup',
      'This computer is not in a mesh yet. A computer that has paired with it joins it on its next sync; nothing else is needed here.'
    )
  }
  // Why the summary decides this sentence: "every member is paired" on a screen that also says "1 not paired"
  // reads as a promise the panel can see it is not keeping.
  if (snapshot.summary.completePairs < snapshot.summary.memberCount) {
    return t(
      'auto.components.settings.hostGroup.inGroupIncomplete',
      'Not every pair is joined yet: each host above says which, and this computer keeps retrying on its own.'
    )
  }
  return t(
    'auto.components.settings.hostGroup.inGroup',
    'Every member is paired with this computer, so each host lists the same workspaces.'
  )
}
