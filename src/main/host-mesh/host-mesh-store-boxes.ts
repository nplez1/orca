import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { HostMeshSealedOffer } from '../../shared/host-mesh/host-mesh-contract'

/**
 * A sealed box as it sits in the file, and the reader that tolerates one this build cannot parse.
 *
 * Why a value that does not parse is dropped rather than refused: the boxes are addressed to this host, so a
 * box it cannot read is one it can never deliver, and refusing the whole file would lose the group with it.
 */
const sealedOfferSchema = lazyZodSchema(() =>
  z.looseObject({
    version: z.literal(1),
    recipientHostKey: z.string().min(1),
    senderHostKey: z.string().min(1),
    nonceB64: z.string().min(1),
    ciphertextB64: z.string().min(1)
  })
)

export function readBoxes(raw: unknown): HostMeshSealedOffer[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    const parsed = sealedOfferSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
