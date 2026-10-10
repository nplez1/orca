import { z } from 'zod'

/**
 * Params for pushing replicated settings and credentials onto a paired host.
 *
 * Why the caps: this is the one method whose body carries other people's secrets, so every array and
 * string is bounded here rather than trusted to the transport's frame limit. A host that receives a
 * truncated payload refuses it by name — `deserializeHostSettingsPayload` in the receiving module.
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

export const HostSettingsReplicationPayloadParams = z
  .object({
    // Why a literal and not a range: a build that does not know this version must refuse the payload,
    // so the schema is what a newer sender fails against rather than a runtime check afterwards.
    version: z.literal(1),
    baseRevision: z.number().int().nonnegative().nullable(),
    revision: z.number().int().nonnegative(),
    upserts: z.array(ReplicatedHostCredentialParams).max(MAX_CREDENTIALS_PER_PAYLOAD),
    removals: z.array(z.string().min(1).max(CREDENTIAL_ID_MAX)).max(MAX_CREDENTIALS_PER_PAYLOAD)
  })
  .strict()

export const ApplyHostSettingsReplicationParams = z
  .object({ payload: HostSettingsReplicationPayloadParams })
  .strict()
