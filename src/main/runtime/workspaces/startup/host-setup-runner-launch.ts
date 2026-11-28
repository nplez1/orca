import { randomUUID } from 'node:crypto'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { buildObservedSetupCommand } from '../../orchestration/workers/launch/setup-completion-signal'

export type ObservedSetupLaunch = {
  command: string
  env?: Record<string, string>
  /** The token `command` prints when it ends; the host watches it. */
  completionToken: string
}

/**
 * The setup command plus the completion token it ends with.
 *
 * One rule for every host that spawns a repo setup runner: the command always
 * carries a token, so its worktree can always be announced as setting up and the
 * sidebar never reads a bare runner as plain "Active". A caller that already
 * wrapped setup around the agent's startup passes that wrapper's token instead,
 * so both halves print the same line.
 */
export function resolveObservedSetupLaunch(
  setup: NonNullable<CreateWorktreeResult['setup']>,
  platform: 'windows' | 'posix',
  wrappedSetup?: { command: string; completionToken: string }
): ObservedSetupLaunch {
  if (wrappedSetup) {
    return { command: wrappedSetup.command, completionToken: wrappedSetup.completionToken }
  }
  const completionToken = randomUUID()
  const observed = buildObservedSetupCommand(
    setup.runnerScriptPath,
    platform,
    completionToken,
    setup.shell
  )
  return { command: observed.command, env: observed.env, completionToken }
}
