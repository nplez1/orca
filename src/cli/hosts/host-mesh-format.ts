import { HOST_MESH_MAX_MEMBERS } from '../../shared/host-mesh/host-mesh-contract'
import type {
  HostMeshJoinRow,
  HostMeshMemberRow,
  HostMeshSnapshotRow,
  HostMeshSummaryRow
} from './host-mesh-rpc'

const PAIR_STATUS_WORDS: Readonly<Record<HostMeshMemberRow['status'], string>> = {
  complete: 'complete',
  needsUpdate: 'needs update',
  half: 'half',
  missing: 'missing'
}

const JOIN_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  unreachable: 'that server did not answer, so nothing was changed',
  'peer-key-mismatch': 'that server’s key does not match the one saved here; re-pair it first',
  'offer-mint-failed': 'this host could not mint its own pairing offer',
  'join-failed': 'that server refused the join'
}

const NOT_IN_GROUP =
  'This host is not in a group. `orca group join <server>` joins the group a paired server belongs to.'

/** One line per member: label, how joined it is, and who introduced it. */
export function formatHostMeshMembers(snapshot: HostMeshSnapshotRow): string[] {
  if (snapshot.members.length === 0) {
    return ['No members yet.']
  }
  const width = Math.max(...snapshot.members.map((member) => member.label.length))
  return snapshot.members.map((member) => {
    const status = PAIR_STATUS_WORDS[member.status].padEnd('complete'.length)
    const introduced = introducedByLabel(member, snapshot)
    return `  ${member.label.padEnd(width)}  ${status}${introduced ? `  (added by ${introduced})` : ''}`
  })
}

/** The introducer as a person reads it: a member's label, this host, or the raw key when it is neither. */
function introducedByLabel(
  member: HostMeshMemberRow,
  snapshot: HostMeshSnapshotRow
): string | null {
  const key = member.introducedBy
  if (!key) {
    return null
  }
  if (key === snapshot.selfKey) {
    return 'this host'
  }
  return snapshot.members.find((candidate) => candidate.hostKey === key)?.label ?? key
}

function describeSummary(summary: HostMeshSummaryRow): string {
  return `${count(summary.memberCount, 'member')}: ${summary.completePairs} paired both ways, ${summary.halfPairs} one-way, ${summary.missingPairs} not paired.`
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

export function formatHostMeshSnapshot(snapshot: HostMeshSnapshotRow): string {
  if (!snapshot.inGroup) {
    return NOT_IN_GROUP
  }
  const lines = [
    `In a group with ${describeSummary(snapshot.summary)}`,
    ...formatHostMeshMembers(snapshot),
    ...(snapshot.summary.atCap ? [`At the ${HOST_MESH_MAX_MEMBERS}-member cap.`] : []),
    ...(snapshot.lastError ? [`Last pass failed: ${snapshot.lastError}`] : [])
  ]
  return lines.join('\n')
}

/** A one-way or absent pairing is the state this command exists to surface, so a script can notice it. */
export function hostMeshNeedsAttention(snapshot: HostMeshSnapshotRow): boolean {
  return snapshot.members.some((member) => member.status !== 'complete')
}

export function describeJoinRefusal(reason: string): string {
  return `Not joined: ${JOIN_REFUSAL_WORDS[reason] ?? reason}.`
}

export function formatHostMeshJoin(outcome: HostMeshJoinRow): string {
  if (outcome.kind === 'refused') {
    return [describeJoinRefusal(outcome.reason), formatHostMeshSnapshot(outcome.snapshot)].join(
      '\n'
    )
  }
  const muted = outcome.muted.length
  const mutedLine =
    muted > 0
      ? [
          `Skipped ${count(muted, 'member')} this host cannot introduce to: ${outcome.muted.join(', ')}.`
        ]
      : []
  return [
    `Joined the group with ${describeSummary(outcome.snapshot.summary)}`,
    ...mutedLine,
    ...formatHostMeshMembers(outcome.snapshot)
  ].join('\n')
}
