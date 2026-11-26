import type { CommandHandler } from '../dispatch/dispatch'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { getDefaultUserDataPath } from '../runtime/profile/metadata'
import { resolveEnvironment } from '../runtime/pairing/environments'
import {
  formatHostMeshJoin,
  formatHostMeshSnapshot,
  hostMeshNeedsAttention
} from './host-mesh-format'
import {
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_LEAVE_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SNAPSHOT_METHOD,
  HOST_MESH_SYNC_METHOD,
  callHostMesh,
  readHostMeshJoin,
  readHostMeshSnapshot,
  type HostMeshMemberRow,
  type HostMeshSnapshotRow
} from './host-mesh-rpc'

const SCOPE =
  '`orca group`. A group is this host’s own membership, stored on this machine, so a routed answer would name a different host’s members.'

const REMOVE_CONFIRM =
  'Removing a member cuts both directions and cannot be undone by re-adding: the tombstone blocks re-introduction. Re-run with --yes to confirm.'
const LEAVE_CONFIRM =
  'Leaving drops every member on this host and cuts both directions; re-joining needs a fresh invitation. Re-run with --yes to confirm.'

/** A script needs to notice a one-way or absent pairing without parsing the table. */
function markBrokenLinks(snapshot: HostMeshSnapshotRow): void {
  if (hostMeshNeedsAttention(snapshot)) {
    process.exitCode = 1
  }
}

function requireStringFlag(flags: ReadonlyMap<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for <${name}>.`)
  }
  return value
}

function requireYes(flags: ReadonlyMap<string, string | boolean>, message: string): void {
  if (flags.get('yes') !== true) {
    throw new RuntimeClientError('confirmation_required', message)
  }
}

async function readSnapshot(client: RuntimeClient) {
  const response = await callHostMesh(client, HOST_MESH_SNAPSHOT_METHOD)
  return { response, snapshot: readHostMeshSnapshot(response.result) }
}

/** A member is named by its label or its host key; an ambiguous label must not remove the wrong machine. */
function resolveMember(snapshot: HostMeshSnapshotRow, requested: string): HostMeshMemberRow {
  const byKey = snapshot.members.find((member) => member.hostKey === requested)
  if (byKey) {
    return byKey
  }
  const byLabel = snapshot.members.filter((member) => member.label === requested)
  if (byLabel.length === 1) {
    return byLabel[0]
  }
  if (byLabel.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `More than one member is labelled ${requested}; pass the host key instead.`
    )
  }
  const labels = snapshot.members.map((member) => member.label).join(', ')
  throw new RuntimeClientError(
    'invalid_argument',
    snapshot.members.length === 0
      ? 'This host is not in a group, so there is no member to remove.'
      : `No member ${requested}. This group has: ${labels}.`
  )
}

export const HOST_MESH_HANDLERS: Record<string, CommandHandler> = {
  'group status': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, SCOPE)
    const { response, snapshot } = await readSnapshot(client)
    printResult(response, json, () => formatHostMeshSnapshot(snapshot))
    markBrokenLinks(snapshot)
  },
  'group join': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, SCOPE)
    const selector = requireStringFlag(flags, 'server')
    // The label the CLI already resolves for --environment, so a join names a server the same way.
    const environment = await resolveEnvironment(getDefaultUserDataPath(), selector)
    const response = await callHostMesh(client, HOST_MESH_JOIN_METHOD, {
      environmentId: environment.id
    })
    const outcome = readHostMeshJoin(response.result)
    printResult(response, json, () => formatHostMeshJoin(outcome))
    if (outcome.kind === 'refused') {
      // Introductions land asynchronously, so a half link right after joining is expected, not a failure.
      process.exitCode = 1
    }
  },
  'group sync': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, SCOPE)
    const response = await callHostMesh(client, HOST_MESH_SYNC_METHOD)
    const snapshot = readHostMeshSnapshot(response.result)
    printResult(response, json, () => formatHostMeshSnapshot(snapshot))
    markBrokenLinks(snapshot)
  },
  'group remove': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, SCOPE)
    const requested = requireStringFlag(flags, 'member')
    requireYes(flags, REMOVE_CONFIRM)
    const { snapshot: before } = await readSnapshot(client)
    const member = resolveMember(before, requested)
    const response = await callHostMesh(client, HOST_MESH_REMOVE_METHOD, {
      hostKey: member.hostKey
    })
    const after = readHostMeshSnapshot(response.result)
    printResult(
      response,
      json,
      () =>
        `Removed ${member.label}. Re-adding it needs a new pairing: the tombstone blocks re-introduction.\n${formatHostMeshSnapshot(after)}`
    )
    markBrokenLinks(after)
  },
  'group leave': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, SCOPE)
    requireYes(flags, LEAVE_CONFIRM)
    const response = await callHostMesh(client, HOST_MESH_LEAVE_METHOD)
    const snapshot = readHostMeshSnapshot(response.result)
    printResult(
      response,
      json,
      () => `Left the group on this host.\n${formatHostMeshSnapshot(snapshot)}`
    )
  }
}
