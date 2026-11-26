#!/usr/bin/env node
/**
 * The packaged-artifact guard, runnable in a second instead of a forty-minute release run.
 *
 * Why: on 2026-11-24 the release dispatch failed in all three package jobs with "Packaged main bundle
 * has bare runtime imports without copied node_modules: socket.io-client" — a static import from
 * `src/main/bots/photon/photon-runtime.ts` that the packaged runtime's root list never carried. The
 * guard that catches this (`verifyPackagedMainRuntimeDeps`) already existed, but it only ran *inside*
 * a full electron-builder packaging job, so the first thing that could tell anyone was the release
 * itself. A local `--dir` build produces the same `Resources` layout in minutes, and this script points
 * the existing guard at it.
 *
 * It never passes without an artifact. Exit 2 means "nothing was checked", which is a refusal to
 * certify rather than a green.
 *
 * Usage:
 *   node local/verify-packaged-bundle.mjs                    find the newest local artifact
 *   node local/verify-packaged-bundle.mjs --resources <dir>  check a named Resources directory
 *
 * Exit: 0 the artifact passes, 1 the guard found a defect, 2 there was no artifact to check.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const require = createRequire(join(repoRoot, 'package.json'))
const { verifyPackagedMainRuntimeDeps } = require(
  join(repoRoot, 'config/packaged-runtime-node-modules.cjs')
)

const SEARCH_ROOTS = ['dist', 'release', 'out/packaged']
const SKIP_DIRS = new Set(['node_modules', '.git', 'app.asar.unpacked'])

/** A packaged layout is a directory named `Resources` holding an `app.asar`. */
function findResources(root, depth = 0) {
  if (depth > 6 || !existsSync(root)) {
    return null
  }
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  if (root.endsWith('Resources') && entries.some((entry) => entry.name === 'app.asar')) {
    return root
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue
    }
    const found = findResources(join(root, entry.name), depth + 1)
    if (found) {
      return found
    }
  }
  return null
}

/**
 * Newest first, so a worktree with several platform builds checks the one just produced.
 * @returns {string | null}
 */
function newestArtifact() {
  /** @type {{ found: string, mtime: number }[]} */
  const candidates = []
  for (const root of SEARCH_ROOTS) {
    const dir = join(repoRoot, root)
    const found = findResources(dir)
    if (found) {
      candidates.push({ found, mtime: statSync(found).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.found ?? null
}

function parseArgs(argv) {
  const index = argv.indexOf('--resources')
  return { resources: index === -1 ? null : (argv[index + 1] ?? null) }
}

const { resources } = parseArgs(process.argv.slice(2))
const target = resources ? resolve(process.cwd(), resources) : newestArtifact()

if (!target) {
  console.error(
    'verify-packaged-bundle: no packaged artifact to check, so nothing is certified.\n' +
      '  Produce one with `pnpm build:unpack` (one platform, ~minutes), then re-run this script.\n' +
      '  The release workflow ran this guard only after packaging, which is why a bare-import defect\n' +
      '  cost a full release dispatch rather than a local minute.'
  )
  process.exit(2)
}

if (!existsSync(join(target, 'app.asar'))) {
  console.error(
    `verify-packaged-bundle: ${target} has no app.asar — not a packaged Resources directory`
  )
  process.exit(2)
}

try {
  verifyPackagedMainRuntimeDeps(target)
  console.log(`verify-packaged-bundle: PASS — ${target} carries every bare runtime import`)
} catch (error) {
  console.error(
    `verify-packaged-bundle: FAIL — ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
