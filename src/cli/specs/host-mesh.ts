import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

const LOCAL_NOTE =
  'Runs on this machine’s own Orca: a group is this host’s membership, so there is no other host to ask.'

const STATUS_NOTE =
  'A member is complete when the pairing exists in both directions, half when only one side recorded it, and missing when neither did. Exits 1 when any member is half or missing, so a script can notice a broken group without parsing the table.'

export const HOST_MESH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['group', 'status'],
    summary: 'Show this host’s host mesh group and how joined each member is',
    usage: 'orca group status [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      LOCAL_NOTE,
      STATUS_NOTE,
      'A member introduced by another one is shown with the member that added it.',
      'With --json, fields are under result: inGroup, groupId, selfKey, members (hostKey, label, introducedBy, status, environmentId), summary and lastError.'
    ],
    examples: ['orca group status', 'orca group status --json']
  },
  {
    path: ['group', 'join'],
    summary: 'Join the group a paired server belongs to, pairing with every member',
    usage: 'orca group join <server> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server'],
    positionalArgs: ['server'],
    notes: [
      LOCAL_NOTE,
      'Names the server the way `orca environment list` does: its saved label or id.',
      'Joining is what creates the other pairings: every existing member is introduced to this host, and each member mints its own offer rather than acting for another.',
      'Joining widens the network the way pairing does. A loopback-only Orca starts listening on every interface; that widening does not reverse.',
      'Introductions land asynchronously, so a member can read half for a moment after joining. `orca group sync` forces a pass.'
    ],
    examples: ['orca group join studio', 'orca group join studio --json']
  },
  {
    path: ['group', 'sync'],
    summary: 'Force one mesh pass and show the group',
    usage: 'orca group sync [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      LOCAL_NOTE,
      'Re-reads every member: syncs membership, collects offers addressed to this host, and retries links it abandoned.',
      STATUS_NOTE
    ],
    examples: ['orca group sync']
  },
  {
    path: ['group', 'remove'],
    summary: 'Eject a member from the group, in both directions',
    usage: 'orca group remove <member> --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'member', 'yes'],
    positionalArgs: ['member'],
    destructive: true,
    notes: [
      LOCAL_NOTE,
      'Names the member by label or host key, as `orca group status` shows it.',
      'Cuts the link in both directions: the member’s credential here, and this host’s reach to it.',
      'A removal is a tombstone, so re-adding the machine later is refused by every member. Pairing it again means removing the tombstone first, which this command does not do.',
      'Requires --yes.'
    ],
    examples: ['orca group remove studio --yes']
  },
  {
    path: ['group', 'leave'],
    summary: 'Leave the group on this host',
    usage: 'orca group leave --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'yes'],
    destructive: true,
    notes: [
      LOCAL_NOTE,
      'Drops every member here and cuts both directions. Other members keep their own pairings, so the rest of the mesh is unaffected.',
      'Re-joining needs a fresh invitation from a member.',
      'Requires --yes.'
    ],
    examples: ['orca group leave --yes']
  }
]
