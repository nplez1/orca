import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { scanGitMarker, resolveRealPath } from './repo-git-marker-scan'
import { gitExecFileAsync } from './runner'

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'
type GitRepoProbe = {
  result: GitRepoProbeResult
  insideWorkTree?: boolean
  gitDir?: string
  commonDir?: string
}

export type GitRepoRegistrationInfo = {
  isRepo: boolean
  rootPath: string
  mainRepoPath: string | null
}

let warnedMarkerFallbackThisSession = false

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Check if a path is a valid git repository (regular or bare). */
export async function isGitRepo(path: string): Promise<boolean> {
  if (!(await isDirectory(path))) {
    return false
  }

  return isGitRepoFromProbe(path, (await probeGitRepo(path)).result)
}

async function isGitRepoFromProbe(path: string, result: GitRepoProbeResult): Promise<boolean> {
  if (result === 'repo') {
    return true
  }
  if (result === 'not-repo') {
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
async function probeGitRepo(path: string, includeLocation = false): Promise<GitRepoProbe> {
  try {
    const records = readGitPathOutput(
      (
        await gitExecFileAsync(
          [
            'rev-parse',
            '--is-inside-work-tree',
            '--is-bare-repository',
            ...(includeLocation ? ['--git-dir', '--git-common-dir'] : [])
          ],
          { cwd: path }
        )
      ).stdout
    ).split('\n')
    const [insideWorkTree, bareRepo, gitDir, commonDir] = records
    const result =
      insideWorkTree === 'true' || bareRepo === 'true'
        ? 'repo'
        : insideWorkTree === 'false' && bareRepo === 'false'
          ? 'not-repo'
          : 'indeterminate'
    const location =
      includeLocation && insideWorkTree === 'true' && records.length !== 4
        ? await readGitRepoDirectories(path)
        : { gitDir, commonDir }
    return { result, insideWorkTree: insideWorkTree === 'true', ...location }
  } catch {
    return { result: 'indeterminate' }
  }
}

/** Reuse one repository discovery across registration's validity, root and worktree checks. */
export async function inspectGitRepoForRegistration(
  path: string
): Promise<GitRepoRegistrationInfo> {
  if (!(await isDirectory(path))) {
    return { isRepo: false, rootPath: path, mainRepoPath: null }
  }
  const probe = await probeGitRepo(path)
  const isRepo = await isGitRepoFromProbe(path, probe.result)
  let rootPath = path
  let mainRepoPath: string | null = null
  if (isRepo && probe.insideWorkTree) {
    try {
      const records = readGitPathOutput(
        (
          await gitExecFileAsync(
            [
              'rev-parse',
              '--is-inside-work-tree',
              '--show-toplevel',
              '--git-dir',
              '--git-common-dir'
            ],
            { cwd: path }
          )
        ).stdout
      ).split('\n')
      const [insideWorkTree, toplevel, gitDir, commonDir] = records
      if (insideWorkTree === 'true') {
        // Newlines in paths make the combined records ambiguous.
        const location =
          records.length === 4 && toplevel && gitDir && commonDir
            ? { toplevel, gitDir, commonDir }
            : {
                toplevel: readGitPathOutput(
                  (await gitExecFileAsync(['rev-parse', '--show-toplevel'], { cwd: path })).stdout
                ),
                ...(await readGitRepoDirectories(path))
              }
        if (location.toplevel) {
          rootPath = normalizeGitRepoRootForInputPath(path, location.toplevel)
          mainRepoPath = await mainRepoPathFromProbe(path, {
            result: 'repo',
            insideWorkTree: true,
            ...location
          })
        } else {
          rootPath = await rootPathFromMarker(path)
        }
      } else {
        rootPath = await rootPathFromMarker(path)
      }
    } catch {
      rootPath = await rootPathFromMarker(path)
    }
  } else if (isRepo) {
    rootPath = await rootPathFromMarker(path)
  }
  return { isRepo, rootPath, mainRepoPath }
}

export async function getGitRepoRoot(path: string): Promise<string> {
  if (!(await isDirectory(path))) {
    return path
  }
  try {
    // One spawn, not two: the spawn count is the cost — a bare repo makes the combined
    // form exit non-zero, and both that throw and the plain `false` land on the same
    // marker-scan fallback below.
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      { cwd: path }
    )
    const [insideWorkTree, toplevel] = stdout.split('\n').map((line) => line.trim())
    if (insideWorkTree === 'true' && toplevel) {
      return normalizeGitRepoRootForInputPath(path, toplevel)
    }
  } catch {
    // Fall through to the marker scan, then to preserving the original path.
  }
  return rootPathFromMarker(path)
}

function readGitPathOutput(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output
}

async function readGitRepoDirectories(
  path: string
): Promise<Pick<GitRepoProbe, 'gitDir' | 'commonDir'>> {
  return {
    gitDir: readGitPathOutput(
      (await gitExecFileAsync(['rev-parse', '--git-dir'], { cwd: path })).stdout
    ),
    commonDir: readGitPathOutput(
      (await gitExecFileAsync(['rev-parse', '--git-common-dir'], { cwd: path })).stdout
    )
  }
}

async function rootPathFromMarker(path: string): Promise<string> {
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
    if (!(await isDirectory(path))) {
      return null
    }
    const mainRepoPath = await mainRepoPathFromProbe(path, await probeGitRepo(path, true))
    return mainRepoPath ? await getGitRepoRoot(mainRepoPath) : null
  } catch {
    return null
  }
}

async function mainRepoPathFromProbe(path: string, probe: GitRepoProbe): Promise<string | null> {
  if (!probe.insideWorkTree || !probe.gitDir || !probe.commonDir) {
    return null
  }
  const absoluteCommonDir = await canonicalizeGitDirPath(resolve(path, probe.commonDir))
  if (
    (await canonicalizeGitDirPath(resolve(path, probe.gitDir))) === absoluteCommonDir ||
    basename(absoluteCommonDir) !== '.git'
  ) {
    return null
  }
  return dirname(absoluteCommonDir)
}

export function normalizeGitRepoRootForInputPath(inputPath: string, rootPath: string): string {
  const inputWsl = parseWslUncPath(inputPath)
  if (inputWsl && rootPath.startsWith('/')) {
    // Why: persist the UNC root so later Git calls keep routing through the WSL runner.
    return toWindowsWslPath(rootPath, inputWsl.distro)
  }
  return normalizeRuntimePathSeparators(rootPath)
}
