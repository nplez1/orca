import { execFileSync, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { resolveCommand } from './wsl-command-resolution'
import { untranslatedGitOutputEnv } from './git-process-env'
import { localLoginShellGitEnvironmentSnapshot } from './local-login-shell-git-environment'

// Why: sync git blocks the main thread; a dead network drive can hang git for minutes without a timeout (issue #7225's 127s freeze).
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
    timeout?: number
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  const spawnStartedAt = performance.now()
  try {
    return execFileSync(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      // Why best-effort: this path is sync, so it can only use a probe that already settled.
      env: untranslatedGitOutputEnv(localLoginShellGitEnvironmentSnapshot(process.env)),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS,
      windowsHide: true
    })
  } finally {
    // Sync exec blocks the main thread for its whole duration — the cost issue #7576 flags.
    recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  }
}
