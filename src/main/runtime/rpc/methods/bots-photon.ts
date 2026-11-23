// The RPC surface for the iMessage channel, beside the other bot connector methods. These are the v1
// surface: the settings card is deferred, so a client drives connect, create, add and release through
// here rather than waiting on a UI.
//
// Every method that *changes* something is `ownerOnly`. Orca's rule is that an agent's CLI never edits
// who may text a bot, and the permission strings do not enforce it: an unstamped local CLI call reads as
// `owner`, so `'workspace'` and `'accounts-admin'` pass for any agent on the box. Without this gate a
// prompt injection could admit an outside number (`member.add`), burn a slug for good
// (`project.delete`), re-point the account (`connect`) or tear the channel down (`bot.release`).
import {
  PhotonAddMemberParams,
  PhotonConnectParams,
  PhotonCreateBotParams,
  PhotonDeleteProjectParams,
  PhotonReconcileParams,
  PhotonReleaseBotParams,
  PhotonReleaseMemberParams,
  PhotonStatusParams,
  type PhotonChannelStatus
} from '../../../../shared/rpc-contract/bots-photon-params'
import { photonChannel, photonChannelStatus } from '../../../bots/photon/photon-runtime'
import { PhotonStore } from '../../../bots/photon/photon-store'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

/** Either a bot Orca still has, or a channel whose bot is gone but whose record still names a project.
 *  The second case matters: after `bots.delete` a released channel's project deletion is the only thing
 *  left to do, and refusing it would leave the slug and the capacity stranded for good. */
async function requireChannel(
  params: { botId: string },
  context: { runtime: Parameters<typeof photonChannel>[0] },
  which: { releasedOk: boolean }
): Promise<void> {
  const live = context.runtime.bots.list().some((bot) => bot.id === params.botId)
  if (live) {
    return
  }
  const record = await new PhotonStore(getAppEnvironment().getPath('userData')).bot(params.botId)
  if (!record || (!which.releasedOk && record.released)) {
    throw new InvalidArgumentError('That bot is gone.')
  }
}

export const BOT_PHOTON_STATUS_METHOD = defineMethod({
  name: 'bots.photon.status',
  permission: 'workspace',
  params: PhotonStatusParams,
  handler: async ({ botId }, context): Promise<PhotonChannelStatus> => {
    context.runtime.bots.assertEnabled()
    const botIds = botId ? [botId] : context.runtime.bots.list().map((bot) => bot.id)
    // The service's own store, not a second one over the same files: a key held for the session lives on
    // that instance, so a fresh store reads it as absent and reports `connected: false` on the default
    // path — the one where `storesKey` is off and the key was never written.
    return photonChannelStatus(photonChannel(context.runtime), botIds)
  }
})

export const BOT_PHOTON_CONNECT_METHOD = defineMethod({
  name: 'bots.photon.connect',
  permission: 'accounts-admin',
  params: PhotonConnectParams,
  handler: async (input, context) => {
    ownerOnly(context, 'Only the owner can connect a Photon account.')
    return photonChannel(context.runtime).connect(input)
  }
})

export const BOT_PHOTON_CREATE_METHOD = defineMethod({
  name: 'bots.photon.create',
  permission: 'workspace',
  params: PhotonCreateBotParams,
  handler: async ({ botId, handle, accountKey }, context) => {
    ownerOnly(context, 'Only the owner can give a bot an iMessage number.')
    await requireChannel({ botId }, context, { releasedOk: false })
    const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
    const outcome = await photonChannel(context.runtime).createBot({
      botId,
      botName: bot?.name ?? botId,
      handle,
      ...(accountKey ? { accountKey } : {})
    })
    return {
      projectId: outcome.record.projectId,
      slug: outcome.record.slug,
      phoneNumber: outcome.record.phoneNumber ?? null,
      created: outcome.createdProject
    }
  }
})

export const BOT_PHOTON_ADD_MEMBER_METHOD = defineMethod({
  name: 'bots.photon.member.add',
  permission: 'workspace',
  params: PhotonAddMemberParams,
  handler: async ({ botId, handle }, context) => {
    ownerOnly(context, 'Only your owner changes who may text a bot, in Orca.')
    await requireChannel({ botId }, context, { releasedOk: false })
    return photonChannel(context.runtime).addMember({ botId, handle })
  }
})

export const BOT_PHOTON_RELEASE_MEMBER_METHOD = defineMethod({
  name: 'bots.photon.member.release',
  permission: 'workspace',
  params: PhotonReleaseMemberParams,
  handler: async ({ botId, handle }, context) => {
    ownerOnly(context, 'Only your owner changes who may text a bot, in Orca.')
    await requireChannel({ botId }, context, { releasedOk: false })
    return photonChannel(context.runtime).releaseMember({ botId, handle })
  }
})

export const BOT_PHOTON_DELETE_METHOD = defineMethod({
  name: 'bots.photon.bot.release',
  permission: 'workspace',
  params: PhotonReleaseBotParams,
  handler: async ({ botId }, context) => {
    ownerOnly(context, 'Only the owner can release a bot’s iMessage channel.')
    await requireChannel({ botId }, context, { releasedOk: true })
    return photonChannel(context.runtime).deleteBot(botId)
  }
})

export const BOT_PHOTON_DELETE_PROJECT_METHOD = defineMethod({
  name: 'bots.photon.project.delete',
  permission: 'accounts-admin',
  params: PhotonDeleteProjectParams,
  handler: async ({ botId, confirmSlug }, context) => {
    ownerOnly(context, 'Only the owner can delete a Photon project; its slug can never be reused.')
    await requireChannel({ botId }, context, { releasedOk: true })
    return photonChannel(context.runtime).deleteProject({ botId, confirmSlug })
  }
})

/** Finishes a half-provisioned bot: the reconciler's production caller, and the repair for a bot whose
 *  project key is missing or whose assignment list has drifted from the provider's. */
export const BOT_PHOTON_RECONCILE_METHOD = defineMethod({
  name: 'bots.photon.reconcile',
  permission: 'workspace',
  params: PhotonReconcileParams,
  handler: async ({ botId }, context) => {
    ownerOnly(context, 'Only the owner can repair a bot’s iMessage channel.')
    await requireChannel({ botId }, context, { releasedOk: false })
    return photonChannel(context.runtime).reconcile(botId)
  }
})

export const BOT_PHOTON_METHODS = [
  BOT_PHOTON_STATUS_METHOD,
  BOT_PHOTON_CONNECT_METHOD,
  BOT_PHOTON_CREATE_METHOD,
  BOT_PHOTON_ADD_MEMBER_METHOD,
  BOT_PHOTON_RELEASE_MEMBER_METHOD,
  BOT_PHOTON_DELETE_METHOD,
  BOT_PHOTON_DELETE_PROJECT_METHOD,
  BOT_PHOTON_RECONCILE_METHOD
]
