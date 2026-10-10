import { z } from 'zod'

/**
 * Params for pushing replicated settings and credentials onto a paired host.
 *
 * Why the caps: this is the one method whose body carries other people's secrets, so every array and
 * string is bounded here rather than trusted to the transport's frame limit.
 */

const CREDENTIAL_ID_MAX = 300
const LABEL_MAX = 300
/** Generous for one API key or one Jira token, small enough that a frame cannot be weaponized. */
const CREDENTIAL_PAYLOAD_MAX = 64_000
const MAX_CREDENTIALS_PER_PAYLOAD = 500

export const ReplicatedHostCredentialParams = z
  .object({
    id: z.string().min(1).max(CREDENTIAL_ID_MAX),
    kind: z.string().min(1).max(CREDENTIAL_ID_MAX),
    label: z.string().min(1).max(LABEL_MAX),
    protection: z.enum(['sealed', 'plaintext']),
    onlyIfEmpty: z.boolean(),
    payload: z.string().max(CREDENTIAL_PAYLOAD_MAX)
  })
  .strict()

// Why no `.strict()` on the payload: an unknown key here is a field a newer sender added, and the
// remote-wire rules say an optional field must be survivable. Rejecting the whole payload — and
// reporting it as a transport failure — is what turns a new field into an outage.
// See docs/reference/remote-wire-compatibility.md.
export const HostSettingsReplicationPayloadParams = z.object({
  // Why a range and not `z.literal(1)`: a literal makes a newer sender fail schema validation, which
  // reaches the main as a generic refusal and is retried forever. Accepting any integer lets
  // `decideHostSettingsPayload` refuse the version by name, which the main maps to a refusal it stops
  // retrying.
  version: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative().nullable(),
  revision: z.number().int().nonnegative(),
  upserts: z.array(ReplicatedHostCredentialParams).max(MAX_CREDENTIALS_PER_PAYLOAD),
  removals: z.array(z.string().min(1).max(CREDENTIAL_ID_MAX)).max(MAX_CREDENTIALS_PER_PAYLOAD),
  unreadable: z
    .array(z.string().min(1).max(CREDENTIAL_ID_MAX))
    .max(MAX_CREDENTIALS_PER_PAYLOAD)
    .optional()
})

export const ApplyHostSettingsReplicationParams = z
  .object({ payload: HostSettingsReplicationPayloadParams })
  .strict()
