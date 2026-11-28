import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import {
  BOT_PHOTON_ADD_MEMBER_METHOD,
  BOT_PHOTON_CONNECT_METHOD,
  BOT_PHOTON_CREATE_METHOD,
  BOT_PHOTON_DELETE_METHOD,
  BOT_PHOTON_DELETE_PROJECT_METHOD,
  BOT_PHOTON_RECONCILE_METHOD,
  BOT_PHOTON_RELEASE_MEMBER_METHOD,
  BOT_PHOTON_SPECTRUM_CONNECT_METHOD,
  BOT_PHOTON_STATUS_METHOD
} from './bots-photon'

/** The gate reads the caller and nothing else, so no member of the runtime is ever touched here. */
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate refuses before the runtime is reached, and the one call it lets through fails on its first member.
const emptyRuntime = {} as RpcContext['runtime']

/** An agent's CLI call, which is what these gates exist to refuse. An unstamped local CLI call reads as
 *  `owner` identity, so the permission string alone passes it — only this gate stops it. */
const agent: RpcContext = { runtime: emptyRuntime, caller: { kind: 'local-cli' } }
const owner: RpcContext = { runtime: emptyRuntime, caller: { kind: 'desktop' } }

/** A method's own params, as its schema parses them. The table below unifies seven different shapes so
 *  one assertion covers them all; each entry is the shape its own method declares. */
type Callable = {
  handler: (params: never, context: RpcContext) => Promise<unknown>
}

/** Every method that changes who may text a bot, what a bot is, or whether a project still exists. */
const CHANGING: { method: Callable; name: string; params: unknown }[] = [
  {
    method: BOT_PHOTON_CONNECT_METHOD,
    name: 'bots.photon.connect',
    params: { organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false }
  },
  {
    method: BOT_PHOTON_CREATE_METHOD,
    name: 'bots.photon.create',
    params: { botId: 'b1', handle: '+15551230000' }
  },
  {
    method: BOT_PHOTON_ADD_MEMBER_METHOD,
    name: 'bots.photon.member.add',
    params: { botId: 'b1', handle: '+15559990000' }
  },
  {
    method: BOT_PHOTON_RELEASE_MEMBER_METHOD,
    name: 'bots.photon.member.release',
    params: { botId: 'b1', handle: '+15559990000' }
  },
  {
    method: BOT_PHOTON_DELETE_METHOD,
    name: 'bots.photon.bot.release',
    params: { botId: 'b1' }
  },
  {
    method: BOT_PHOTON_DELETE_PROJECT_METHOD,
    name: 'bots.photon.project.delete',
    params: { botId: 'b1', confirmSlug: 'orca-bot-scout' }
  },
  {
    method: BOT_PHOTON_RECONCILE_METHOD,
    name: 'bots.photon.reconcile',
    params: { botId: 'b1' }
  }
]

/** What the call threw, or null when it went through the gate. */
async function outcomeOf(method: Callable, params: unknown, context: RpcContext): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each entry's params are the shape its own method's schema parses; the table cannot express seven param types as one.
  const call = method.handler(params as never, context)
  return call.then(
    () => null,
    (error: unknown) => error
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

describe('which caller may change a bot’s iMessage channel', () => {
  for (const { method, name, params } of CHANGING) {
    it(`refuses an agent’s CLI call to ${name}`, async () => {
      // The refusal must come from the gate: an empty runtime fails with something else entirely.
      const error = await outcomeOf(method, params, agent)
      expect(messageOf(error)).toMatch(/^Only/)
    })
  }

  it('lets the owner through the gate on each of them', async () => {
    for (const { method, params } of CHANGING) {
      // Past the gate these fail on the empty runtime, which is how this proves the gate is what
      // refused the agent above rather than a shared failure both callers hit.
      expect(messageOf(await outcomeOf(method, params, owner))).not.toMatch(/^Only/)
    }
  })

  it('leaves the read-only status call open, because reading it changes nothing', async () => {
    expect(messageOf(await outcomeOf(BOT_PHOTON_STATUS_METHOD, {}, agent))).not.toMatch(
      /Only the owner/
    )
  })

  it('lets an agent connect this bot’s own Spectrum project, the one changing call without the gate', async () => {
    // Deliberate: that credential is one project's own pair, it creates nothing upstream and it can only
    // reach the bot it names, so it is not the account-wide blast radius the gate exists for.
    const error = await outcomeOf(
      BOT_PHOTON_SPECTRUM_CONNECT_METHOD,
      { botId: 'b1', projectId: 'pho_prj_1', projectSecret: 'pho_sk_project_secret' },
      agent
    )
    expect(messageOf(error)).not.toMatch(/^Only/)
  })
})
