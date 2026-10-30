import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { CLI_COMMAND_NAME } from '../../cli/cli-install-constants'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide' | 'orca-np'

/** Dev builds run the CLI as `orca-dev`; a packaged app, or a process with no app, must not advertise it. */
export function runtimeOrchestrationCliCommand(): OrchestrationCliCommand | undefined {
  return hasAppEnvironment() && !getAppEnvironment().isPackaged() ? 'orca-dev' : undefined
}

/** What a local, non-WSL terminal is told to run; a structured session is always one. */
export function localOrchestrationCliCommand(): OrchestrationCliCommand {
  return runtimeOrchestrationCliCommand() ?? 'orca'
}

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  runtimeCliCommand?: OrchestrationCliCommand
}): OrchestrationCliCommand {
  if (args.connectionId) {
    return 'orca'
  }
  if (args.runtimeCliCommand) {
    return args.runtimeCliCommand
  }
  // Why the guest command and not upstream's `orca-ide`: this build registers `orca-np` in the WSL
  // guest and puts only that name on the managed PATH, so `orca-ide` reaches an official install or
  // nothing at all.
  if (args.isWsl !== null && args.isWsl !== undefined) {
    return args.isWsl ? CLI_COMMAND_NAME : 'orca'
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return CLI_COMMAND_NAME
  }

  const worktreePath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath
  return worktreePath && isWslUncPath(worktreePath) ? CLI_COMMAND_NAME : 'orca'
}
