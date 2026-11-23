// Which version of a bot's tools a chat launched with, so a chat whose tools changed starts again at
// its next turn. A revision is an opaque digest; the epoch counts this host's own tool writes and
// finished sign-ins per bot folder (a login outside this Orca shows only through the file).
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { botGithubAppIdentityOutdated } from './bot-gh-app-identity'

const epochs = new Map<string, number>()

const key = (folder: string): string => resolve(folder)

export function botToolsEpoch(folder: string): number {
  return epochs.get(key(folder)) ?? 0
}

/** After a tools write or a sign-in that finished; never for one still pending or failed. */
export function advanceBotToolsEpoch(folder: string): void {
  epochs.set(key(folder), botToolsEpoch(folder) + 1)
}

export function forgetBotToolsEpoch(folder: string): void {
  epochs.delete(key(folder))
}

/** `version` is the tools file's own digest, never the saved values themselves. */
export function botToolsRevision(version: string, epoch: number): string {
  return createHash('sha256').update(`${version}\0${epoch}`).digest('hex')
}

/** The GitHub App a launch's `gh` acted as: the identity epoch it launched under, and that installation. */
export type BotLaunchedAppIdentity = {
  /** `appIdentityEpoch()` at launch: a connect or disconnect after it makes the session stale. */
  epoch: number
  /** The installation it minted a token for; null when no App was connected. */
  installationId: number | null
  /** When that token dies; null when no App was connected. */
  expiresAtMs: number | null
}

/** What a launch read, from one snapshot, for the chat's later comparisons. */
export type BotLaunchedTools = {
  folder: string
  revision: string
  epoch: number
  appIdentity: BotLaunchedAppIdentity
}

/** A chat's tools against what its next launch would get: a changed file, Orca's own write, or a stale App. */
function botLaunchedToolsOutdated(launched: BotLaunchedTools, revision?: string): boolean {
  return (
    botGithubAppIdentityOutdated(launched.appIdentity) ||
    botToolsEpoch(launched.folder) !== launched.epoch ||
    (revision !== undefined && revision !== launched.revision)
  )
}

/** The two checks a host's delivery loop asks of a chat's launch; absent means it never refreshes. */
export function botLaunchToolsChecks(
  launchedOf: (sessionId: string) => BotLaunchedTools | undefined,
  revisionOf: (folder: string) => Promise<string>
): {
  changed: (sessionId: string) => Promise<boolean>
  outdated: (sessionId: string) => boolean
} {
  return {
    changed: async (sessionId) => {
      const launched = launchedOf(sessionId)
      return (
        launched !== undefined &&
        botLaunchedToolsOutdated(launched, await revisionOf(launched.folder))
      )
    },
    outdated: (sessionId) => {
      const launched = launchedOf(sessionId)
      return launched !== undefined && botLaunchedToolsOutdated(launched)
    }
  }
}
