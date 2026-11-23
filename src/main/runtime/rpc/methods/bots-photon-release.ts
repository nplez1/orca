// Letting a bot's iMessage channel go as part of deleting the bot. Split from the RPC file so the delete
// handler gains one call rather than an error path: a teardown that cannot run is reported, never allowed
// to block the delete, because the record stays and the release can be finished afterwards.
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { photonChannel } from '../../../bots/photon/photon-runtime'

/** Releases the channel's numbers and key for a bot that is being deleted. Silent for a bot that never
 *  had one, which is most of them. */
export async function releaseDeletedPhotonChannel(
  runtime: OrcaRuntimeService,
  botId: string
): Promise<void> {
  try {
    const channel = photonChannel(runtime)
    if (!(await channel.hasChannel(botId))) {
      return
    }
    const outcome = await channel.deleteBot(botId)
    if (outcome.problems.length > 0) {
      console.warn('[photon] a deleted bot’s channel is only partly released', outcome.problems)
    }
  } catch (error) {
    // A store this build cannot read is reported and the delete continues, as this file's header says:
    // the record stays untouched, so releasing the channel is still possible once the file is readable.
    // Throwing here blocked deleting any bot whose Photon store was corrupt, which is the opposite.
    console.warn('[photon] could not release a deleted bot’s channel', error)
  }
}
