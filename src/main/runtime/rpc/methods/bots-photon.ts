// The RPC surface for the iMessage channel, beside the other bot connector methods. These are the v1
// surface: the settings card is deferred, so a client drives connect, create, add and release through
// here rather than waiting on a UI.
import {
  PhotonAddMemberParams,
  PhotonConnectParams,
  PhotonCreateBotParams,
  PhotonDeleteProjectParams,
  PhotonReleaseBotParams,
  PhotonReleaseMemberParams,
  PhotonStatusParams,
  type PhotonChannelStatus
} from '../../../../shared/rpc-contract/bots-photon-params'
import { photonChannel, photonChannelStatus } from '../../../bots/photon/photon-runtime'
import { PhotonStore } from '../../../bots/photon/photon-store'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { defineMethod, InvalidArgumentError } from '../core'

function requireBot(
  botId: string,
  context: { runtime: Parameters<typeof photonChannel>[0] }
): void {
  if (!context.runtime.bots.list().some((bot) => bot.id === botId)) {
    throw new InvalidArgumentError('That bot is gone.')
  }
}

export const BOT_PHOTON_STATUS_METHOD = defineMethod({
  name: 'bots.photon.status',
  permission: 'workspace',
  params: PhotonStatusParams,
  handler: async ({ botId }, context): Promise<PhotonChannelStatus> => {
    context.runtime.bots.assertEnabled()
    const store = new PhotonStore(getAppEnvironment().getPath('userData'))
    const botIds = botId ? [botId] : context.runtime.bots.list().map((bot) => bot.id)
    return photonChannelStatus(photonChannel(context.runtime), store, botIds)
  }
})

export const BOT_PHOTON_CONNECT_METHOD = defineMethod({
  name: 'bots.photon.connect',
  permission: 'accounts-admin',
  params: PhotonConnectParams,
  handler: async (input, context) => photonChannel(context.runtime).connect(input)
})

export const BOT_PHOTON_CREATE_METHOD = defineMethod({
  name: 'bots.photon.create',
  permission: 'workspace',
  params: PhotonCreateBotParams,
  handler: async ({ botId, handle }, context) => {
    requireBot(botId, context)
    const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
    const outcome = await photonChannel(context.runtime).createBot({
      botId,
      botName: bot?.name ?? botId,
      handle
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
    requireBot(botId, context)
    return photonChannel(context.runtime).addMember({ botId, handle })
  }
})

export const BOT_PHOTON_RELEASE_MEMBER_METHOD = defineMethod({
  name: 'bots.photon.member.release',
  permission: 'workspace',
  params: PhotonReleaseMemberParams,
  handler: async ({ botId, handle }, context) => {
    requireBot(botId, context)
    return photonChannel(context.runtime).releaseMember({ botId, handle })
  }
})

export const BOT_PHOTON_DELETE_METHOD = defineMethod({
  name: 'bots.photon.bot.release',
  permission: 'workspace',
  params: PhotonReleaseBotParams,
  handler: async ({ botId }, context) => {
    requireBot(botId, context)
    return photonChannel(context.runtime).deleteBot(botId)
  }
})

export const BOT_PHOTON_DELETE_PROJECT_METHOD = defineMethod({
  name: 'bots.photon.project.delete',
  permission: 'accounts-admin',
  params: PhotonDeleteProjectParams,
  handler: async ({ botId, confirmSlug }, context) => {
    requireBot(botId, context)
    return photonChannel(context.runtime).deleteProject({ botId, confirmSlug })
  }
})

export const BOT_PHOTON_METHODS = [
  BOT_PHOTON_STATUS_METHOD,
  BOT_PHOTON_CONNECT_METHOD,
  BOT_PHOTON_CREATE_METHOD,
  BOT_PHOTON_ADD_MEMBER_METHOD,
  BOT_PHOTON_RELEASE_MEMBER_METHOD,
  BOT_PHOTON_DELETE_METHOD,
  BOT_PHOTON_DELETE_PROJECT_METHOD
]
