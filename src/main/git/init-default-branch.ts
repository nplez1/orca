import { gitExecFileAsync } from './runner'

/**
 * Branch name `git init` is about to create in `cwd`, read from the same config git itself will
 * read, so the primary checkout's folder can be named for it.
 *
 * Falls back to `main` — git's built-in default varies by version and user config, and this is
 * also the fallback the project-folder layout documents. The folder name is a label written
 * once: renaming the branch afterwards deliberately does not move it.
 */
export async function getInitDefaultBranchName(cwd: string): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['config', '--get', 'init.defaultBranch'], { cwd })
    return stdout.trim() || 'main'
  } catch {
    // Unset exits non-zero, and an unusable cwd throws; both mean "no configured default".
    return 'main'
  }
}
