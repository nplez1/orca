import { readFile, stat } from 'node:fs/promises'
import { realpath } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../shared/gitdir-marker-payload'

export type GitMarkerScanResult =
  | { status: 'valid'; rootPath: string }
  | { status: 'absent' | 'invalid' }

function realpathNative(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolvedPath) => {
      if (error) {
        reject(error)
        return
      }
      resolve(resolvedPath)
    })
  })
}

/**
 * Filesystem fallback for genuine Git metadata when git cannot answer cleanly.
 *
 * Why every step is async: this walks one directory per ancestor up to the filesystem root, so on
 * a FileProvider, redirector, or network path each step is a round trip. Done with sync fs it
 * blocked the main thread for the whole walk — the cost that made repo detection freeze on exactly
 * the machines whose paths are slowest.
 */
export async function scanGitMarker(path: string): Promise<GitMarkerScanResult> {
  const realPath = await resolveRealPath(path)
  if (realPath && realPath !== path) {
    const [lexicalScan, realPathScan] = await Promise.all([
      scanGitMarkerAncestors(path),
      scanGitMarkerAncestors(realPath)
    ])
    if (
      lexicalScan.status === 'valid' &&
      realPathScan.status === 'valid' &&
      (await pathsReferToSameEntry(lexicalScan.rootPath, realPathScan.rootPath))
    ) {
      // Why: preserve lexical spellings, but let a cross-repo symlink bind to its real target.
      return lexicalScan
    }
    return realPathScan
  }
  return scanGitMarkerAncestors(path)
}

export async function resolveRealPath(path: string): Promise<string | null> {
  try {
    return await realpathNative(path)
  } catch {
    return null
  }
}

async function scanGitMarkerAncestors(path: string): Promise<GitMarkerScanResult> {
  for (const candidate of ancestorDirectories(path)) {
    if (!(await isInsideDotGitMarker(candidate, path))) {
      const worktreeMarker = await scanWorktreeMarker(candidate)
      if (worktreeMarker.status !== 'absent') {
        return worktreeMarker
      }
    }
    if (await hasValidBareRepoMarker(candidate)) {
      return { status: 'valid', rootPath: candidate }
    }
  }
  return { status: 'absent' }
}

function ancestorDirectories(path: string): string[] {
  const directories: string[] = []
  let current = path
  while (true) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return directories
    }
    current = parent
  }
}

async function isInsideDotGitMarker(rootPath: string, targetPath: string): Promise<boolean> {
  const relativePath = relative(rootPath, targetPath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false
  }
  const firstSegment = relativePath.split(/[\\/]+/)[0]
  if (firstSegment === '.git') {
    return true
  }
  if (firstSegment.toLowerCase() !== '.git') {
    return false
  }
  return pathsReferToSameEntry(join(rootPath, firstSegment), join(rootPath, '.git'))
}

async function pathsReferToSameEntry(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const leftStat = await stat(leftPath)
    const rightStat = await stat(rightPath)
    if (leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
      return true
    }
    const leftRealPath = normalizeRuntimePathSeparators(await realpathNative(leftPath))
    const rightRealPath = normalizeRuntimePathSeparators(await realpathNative(rightPath))
    return process.platform === 'win32'
      ? leftRealPath.toLowerCase() === rightRealPath.toLowerCase()
      : leftRealPath === rightRealPath
  } catch {
    return false
  }
}

async function scanWorktreeMarker(worktreePath: string): Promise<GitMarkerScanResult> {
  const dotGit = join(worktreePath, '.git')
  let marker: Stats
  try {
    marker = await stat(dotGit)
  } catch {
    return { status: 'absent' }
  }

  if (marker.isDirectory()) {
    return (await hasValidGitDirectory(dotGit))
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  if (marker.isFile()) {
    let gitDir: string | null
    try {
      gitDir = parseGitdirFile(worktreePath, await readFile(dotGit, 'utf8'))
    } catch {
      return { status: 'invalid' }
    }
    return gitDir !== null && (await hasValidGitDirectory(gitDir))
      ? { status: 'valid', rootPath: worktreePath }
      : { status: 'invalid' }
  }
  return { status: 'invalid' }
}

function parseGitdirFile(basePath: string, content: string): string | null {
  const payload = parseGitdirMarkerPayload(content)
  return payload === null ? null : resolveGitMetadataPath(basePath, payload)
}

async function hasValidGitDirectory(gitDir: string): Promise<boolean> {
  // Why: keep the original short-circuit — the linked-worktree probe costs extra stats.
  if (await hasValidCommonGitDirectory(gitDir)) {
    return true
  }
  return hasValidLinkedWorktreeGitDirectory(gitDir)
}

async function hasValidCommonGitDirectory(gitDir: string): Promise<boolean> {
  try {
    return (
      (await stat(join(gitDir, 'HEAD'))).isFile() &&
      (await stat(join(gitDir, 'objects'))).isDirectory() &&
      (await stat(join(gitDir, 'refs'))).isDirectory()
    )
  } catch {
    return false
  }
}

async function hasValidLinkedWorktreeGitDirectory(gitDir: string): Promise<boolean> {
  try {
    if (
      !(await stat(join(gitDir, 'HEAD'))).isFile() ||
      !(await stat(join(gitDir, 'commondir'))).isFile()
    ) {
      return false
    }
    const commonDir = resolveGitMetadataPath(
      gitDir,
      await readFile(join(gitDir, 'commondir'), 'utf8')
    )
    return commonDir !== null && (await hasValidCommonGitDirectory(commonDir))
  } catch {
    return false
  }
}

async function hasValidBareRepoMarker(path: string): Promise<boolean> {
  return (await hasValidCommonGitDirectory(path)) && !(await gitConfigDeclaresNonBare(path))
}

async function gitConfigDeclaresNonBare(gitDir: string): Promise<boolean> {
  try {
    const config = await readFile(join(gitDir, 'config'), 'utf8')
    let inCoreSection = false
    for (const line of config.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]/)
      if (section) {
        inCoreSection = section[1].trim().toLowerCase() === 'core'
        continue
      }
      const bare = line.match(/^\s*bare\s*=\s*(.*?)\s*$/i)
      if (inCoreSection && bare) {
        return isGitBooleanFalse(normalizeGitConfigValue(bare[1]))
      }
    }
    return false
  } catch {
    return false
  }
}

function normalizeGitConfigValue(value: string): string {
  const unescaped = stripGitConfigInlineComment(value).trim().replace(/\\"/g, '"')
  if (
    unescaped.length >= 2 &&
    ((unescaped.startsWith('"') && unescaped.endsWith('"')) ||
      (unescaped.startsWith("'") && unescaped.endsWith("'")))
  ) {
    return unescaped.slice(1, -1)
  }
  return unescaped
}

function stripGitConfigInlineComment(value: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' || char === ';') {
      return value.slice(0, i)
    }
  }
  return value
}

function isGitBooleanFalse(value: string): boolean {
  return ['', 'false', 'no', 'off', '0'].includes(value.toLowerCase())
}
