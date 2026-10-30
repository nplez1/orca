import type { GitAdmissionTier } from './git-exec-options'

/** Result of a streamed git command; `stoppedEarly` is true when onStdout asked to stop before the child exited. */
export type GitStreamResult = { stoppedEarly: boolean }

export type GitStreamOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project (local-git-runtime-route.ts); say why. */
  hostGit?: true
  preferWslDirectGit?: boolean
  signal?: AbortSignal
  /** Byte backstop; defaults to DEFAULT_GIT_MAX_BUFFER. */
  maxBuffer?: number
  /** Explicit wall-clock deadline; read commands default to the production backstop. */
  timeoutMs?: number
  /** Overrides only the default read deadline in tests. */
  timeoutMsForTest?: number
  admissionTier?: GitAdmissionTier
  /**
   * Called for each decoded stdout chunk. Return true to stop: the child is
   * killed and the promise resolves with stoppedEarly=true.
   */
  onStdout: (chunk: string) => boolean | void
}
