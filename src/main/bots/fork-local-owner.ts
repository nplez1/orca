// A local ask is the owner's own: the command runs as their user on this computer, so the turn it
// opens names them as a person instead of the bare owner a cloud turn falls back to.
import { userInfo } from 'node:os'
import { ownerAsPerson, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { sessionCallerOf } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../runtime/rpc/core'
import type { BotActingTurn } from './bot-request-asker'

/** What a send to a bot says about its caller: the session behind it, and what the transport proved. */
export type BotMailContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationCaller' | 'callerScope' | 'recordMutationReceipt'
>

/** The owner of this computer, by the login they run the command as; null when the host names none. */
export function localOwnerAsker(): BotRequestAsker | null {
  let username = ''
  try {
    username = userInfo().username.trim()
  } catch (error) {
    // No passwd entry for this uid: an unnamed send is the bare owner, never a failed one.
    console.warn('[bots] could not read this computer’s login name', error)
    return null
  }
  return ownerAsPerson(username ? { userId: username, name: username } : { userId: 'local-owner' })
}

/** A turn nobody but the owner on this computer opened, with the owner named in it. */
export function localOwnerTurn(turn: BotActingTurn): BotActingTurn {
  const owner = localOwnerAsker()
  if (!owner) {
    return turn
  }
  const askers = [owner]
  return { ...turn, askers, askedBy: askers }
}

/**
 * Whether a send is this computer's owner at their own shell: no session behind it, and a caller the
 * transport did not prove to be a paired device. Another computer's mail arrives with no session either,
 * so the scope is what keeps it from being stamped as this computer's owner.
 */
export function botMailCallerOf(
  context: Pick<BotMailContext, 'orchestrationCaller' | 'callerScope'>,
  baseTurn: BotActingTurn
): { callerSessionId: string | undefined; turn: BotActingTurn } {
  const callerSessionId = sessionCallerOf(context.orchestrationCaller)?.sessionId
  const localOwner =
    callerSessionId === undefined &&
    (context.callerScope === undefined || context.callerScope.kind === 'owner')
  return { callerSessionId, turn: localOwner ? localOwnerTurn(baseTurn) : baseTurn }
}
