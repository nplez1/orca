import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { scanGitMarker, resolveRealPath } from './repo-git-marker-scan'
import { gitExecFileAsync } from './runner'

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'

let warnedMarkerFallbackThisSession = false

/** Check if a path is a valid git repository (regular or bare). */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return false
    }
  } catch {
    return false
  }

  const gitProbeResult = await probeGitRepo(path)
  if (gitProbeResult === 'repo') {
    return true
  }
  if (gitProbeResult === 'not-repo') {
    return false
  }

  const markerScan = await scanGitMarker(path)
  if (markerScan.status === 'valid' && !warnedMarkerFallbackThisSession) {
    warnedMarkerFallbackThisSession = true
    console.warn('[isGitRepo] git rev-parse could not confirm repo; accepted via .git marker', {
      path
    })
  }
  return markerScan.status === 'valid'
}

/** Only a clean pair of negative Git answers is a definitive non-repo. */
async function probeGitRepo(path: string): Promise<GitRepoProbeResult> {
  let sawFailure = false

  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    })
    const insideWorkTree = stdout.trim()
    if (insideWorkTree === 'true') {
      return 'repo'
    }
    if (insideWorkTree !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--is-bare-repository'], {
      cwd: path
    })
    const bareRepo = stdout.trim()
    if (bareRepo === 'true') {
      return 'repo'
    }
    if (bareRepo !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  return sawFailure ? 'indeterminate' : 'not-repo'
}

export async function getGitRepoRoot(path: string): Promise<string> {
  let isDirectory: boolean
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch {
    return path
  }
  if (!isDirectory) {
    return path
  }
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    })
    if (stdout.trim() === 'true') {
      const root = await gitExecFileAsync(['rev-parse', '--show-toplevel'], { cwd: path })
      return normalizeGitRepoRootForInputPath(path, root.stdout.trim())
    }
  } catch {
    // Fall through to the marker scan, then to preserving the original path.
  }
  const markerScan = await scanGitMarker(path)
  if (markerScan.status === 'valid') {
    return normalizeGitRepoRootForInputPath(path, markerScan.rootPath)
  }
  return path
}

async function canonicalizeGitDirPath(path: string): Promise<string> {
  return (await resolveRealPath(path)) ?? path
}

/** Return the main-checkout path only when `path` is a linked worktree. */
export async function getLinkedWorktreeMainRepoRoot(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return null
    }
    const { stdout: insideWorkTree } = await gitExecFileAsync(
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: path }
    )
    if (insideWorkTree.trim() !== 'true') {
      return null
    }
    const { stdout } = await gitExecFileAsync(['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd: path
    })
    const [gitDir, commonDir] = stdout.split('\n').map((line) => line.trim())
    if (!gitDir || !commonDir) {
      return null
    }
    const absoluteCommonDir = await canonicalizeGitDirPath(resolve(path, commonDir))
    if ((await canonicalizeGitDirPath(resolve(path, gitDir))) === absoluteCommonDir) {
      return null
    }
    if (basename(absoluteCommonDir) !== '.git') {
      return null
    }
    return getGitRepoRoot(dirname(absoluteCommonDir))
  } catch {
    return null
  }
}

export function normalizeGitRepoRootForInputPath(inputPath: string, rootPath: string): string {
  const inputWsl = parseWslUncPath(inputPath)
  if (inputWsl && rootPath.startsWith('/')) {
    // Why: persist the UNC root so later Git calls keep routing through the WSL runner.
    return toWindowsWslPath(rootPath, inputWsl.distro)
  }
  return normalizeRuntimePathSeparators(rootPath)
}
