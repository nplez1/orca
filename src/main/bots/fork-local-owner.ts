// A local ask is the owner's own: the command runs as their user on this computer, so the turn it
// opens names them as a person instead of the bare owner a cloud turn falls back to.
import { userInfo } from 'node:os'
import { ownerAsPerson, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotActingTurn } from './bot-request-asker'

/** The owner of this computer, by the login they run the command as. */
export function localOwnerAsker(): BotRequestAsker {
  const username = userInfo().username.trim()
  const userId = username || 'local-owner'
  return ownerAsPerson({ userId, name: username })
}

/** A turn nobody but the owner on this computer opened, with the owner named in it. */
export function localOwnerTurn(turn: BotActingTurn): BotActingTurn {
  const askers = [localOwnerAsker()]
  return { ...turn, askers, askedBy: askers }
}
