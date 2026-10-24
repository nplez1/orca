/**
 * Which files make a flaky pass a claim about this branch.
 *
 * Gate 1 gives an unallowlisted failure one isolated re-run. A pass there means the failure needs
 * full-suite load — a different claim from "this change broke it" — so the gate waives it. The first
 * version asked only whether the *test* file was in the branch diff, which waived a branch that
 * changed `src/x.ts` and broke `x.test.ts` one run in ten (fork issue #150, item 4).
 *
 * So a test is coupled to itself, the module it sits beside, the modules it imports, and the files
 * every test runs under. Why not the reverse import graph: `config/scripts/ci-unit-selection.mjs`
 * answers the inverse question for a different consumer, and a test's own imports are the half of it
 * that is both cheap and stable here.
 *
 * Known limits, both deliberate: imports are followed one level (a module the test imports is not
 * itself walked), and a workspace-package specifier (`@orca/…`) is skipped rather than guessed.
 * Each can only waive a flake a branch caused, never refuse one it did not.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_FILE_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']
// Only the aliases a test file actually reaches for; an unresolved bare specifier is skipped rather
// than guessed, because a wrong answer would waive a flake this branch caused.
const SOURCE_ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
const IMPORT_SPECIFIER =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Files every unit test runs under, by name, because no test imports them: the runner, the setup
 * files it installs, and the dependency graph the whole suite resolves against.
 */
export const SHARED_TEST_INPUTS = [
  'config/vitest.config.ts',
  // Not an import the parser sees: the config loads it through `createRequire(import.meta.url)(…)`.
  'config/dark-build-switches.cjs',
  'config/scripts/run-vitest.mjs',
  // Why a directory: the runner's one bare import is the whole process-host package, and a trailing
  // slash couples to any file in it.
  'src/packages/process-host/',
  'config/scripts/vitest-real-agent-home-write-guard.ts',
  'config/scripts/vitest-bun-node-builtins.ts',
  'config/scripts/vitest-dom-setup.ts',
  'config/scripts/vitest-host-ports-setup.ts',
  'config/scripts/vitest-caller-identity-env-setup.ts',
  'package.json',
  'pnpm-lock.yaml'
]

// Why these two are read rather than listed: their imports are where a pool, a timeout or the file
// selection actually lives, and a hand list went stale the first time (it missed the node-runtime
// pool, the sequencer and the runtime file set, so a branch that re-seated tests into that pool could
// still waive its own flake).
const HARNESS_ROOT_FILES = ['config/vitest.config.ts', 'config/scripts/run-vitest.mjs']

export function importSpecifiers(source) {
  const specifiers = []
  for (const match of String(source ?? '').matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (specifier) {
      specifiers.push(specifier)
    }
  }
  return specifiers
}

function readRepoFile(path) {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return ''
  }
}

function withSourceExtensions(base) {
  const candidates = [base]
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${base}${extension}`)
  }
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${base}/index${extension}`)
  }
  return candidates
}

function resolveImport(specifier, fromFile) {
  for (const [prefix, replacement] of SOURCE_ALIASES) {
    if (specifier.startsWith(prefix)) {
      return withSourceExtensions(`${replacement}${specifier.slice(prefix.length)}`)
    }
  }
  return specifier.startsWith('.')
    ? withSourceExtensions(join(dirname(fromFile), specifier).replaceAll('\\', '/'))
    : []
}

function siblingModules(testFile) {
  const base = testFile.replace(TEST_FILE_SUFFIX, '')
  return base === testFile ? [] : withSourceExtensions(base)
}

let sharedPaths = null

/**
 * `SHARED_TEST_INPUTS` plus the modules the runner and the config import, one level deep. Why one
 * level: that is where the pool, the sequencer and the file selection are named, and a deeper walk
 * would cover most of `config/scripts/`.
 */
export function sharedHarnessPaths() {
  if (sharedPaths) {
    return sharedPaths
  }
  const paths = new Set(SHARED_TEST_INPUTS)
  for (const file of HARNESS_ROOT_FILES) {
    for (const specifier of importSpecifiers(readRepoFile(file))) {
      for (const candidate of resolveImport(specifier, file)) {
        paths.add(candidate)
      }
    }
  }
  sharedPaths = [...paths]
  return sharedPaths
}

/** Repo-relative paths whose change makes a flaky pass a claim about this branch. */
export function branchCoupledPaths(testFile, readSource = readRepoFile) {
  const paths = new Set([testFile, ...siblingModules(testFile)])
  for (const specifier of importSpecifiers(readSource(testFile))) {
    for (const resolved of resolveImport(specifier, testFile)) {
      paths.add(resolved)
    }
  }
  return [...paths]
}

/** A trailing slash in the harness set means "any file under this directory". */
function sharedMatch(diffFiles) {
  const shared = sharedHarnessPaths()
  for (const path of shared) {
    if (!path.endsWith('/') && diffFiles.has(path)) {
      return path
    }
  }
  const prefixes = shared.filter((path) => path.endsWith('/'))
  for (const file of diffFiles) {
    const prefix = prefixes.find((candidate) => file.startsWith(candidate))
    if (prefix) {
      return prefix
    }
  }
  return null
}

/**
 * A flaky pass is waived only when nothing the test is coupled to is in the branch diff. A diff that
 * could not be resolved is never waived.
 */
export function flakeWaiver(testFile, diffFiles, readSource = readRepoFile) {
  if (!diffFiles) {
    return { inDiff: true, matched: null }
  }
  const shared = sharedMatch(diffFiles)
  if (shared) {
    return { inDiff: true, matched: shared }
  }
  const matched = branchCoupledPaths(testFile, readSource).find((path) => diffFiles.has(path))
  return { inDiff: matched !== undefined, matched: matched ?? null }
}
