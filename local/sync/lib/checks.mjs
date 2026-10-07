// Gates both sync tools share: conflict markers, the derived localization catalog, and pnpm tc.
//
// Why shared: pre-sync proves the *starting* tip is green and post-sync proves the *merged* tip
// is, and the two only mean something together. If one scanned a different directory set, or
// treated git grep's exit 1 as a failure, the pair's signal would be unusable in exactly the
// situation it was built for.
//
// These return a `{ status, summary, details }` outcome; the calling tool owns the check's title,
// its remediation text and its place in the report, so the two tools can describe the same gate
// differently ("is in sync" before the rebase, "regenerates to no diff" after it).

import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  STATUS,
  git,
  gitText,
  headText,
  pnpmCommand,
  repoRoot,
  run,
  tailText,
  toolExists,
  toolPath
} from './run.mjs'

export const CATALOG = 'src/renderer/src/i18n/en-runtime-required.json'
export const TYPE_CHECK_COMMAND = 'pnpm tc'
// `=======` alone is a markdown rule and a table separator, so only the unambiguous markers count.
const MARKER_PATTERN = '^(<{7}|>{7}|\\|{7})'
const MARKER_DIRS = ['src', 'config', 'mobile', 'resources', '.github']

// post-sync passes delegate: conflicts.mjs --verify is the fork's own verifier, so when it exists
// it decides, and the direct scan below is only the fallback.
export function conflictMarkers({ delegate = false } = {}) {
  const verifier = 'conflicts.mjs'
  if (delegate && toolExists(verifier)) {
    const result = run('node', [toolPath(verifier), '--verify'], { cwd: repoRoot() })
    return {
      status: result.ok ? STATUS.passed : STATUS.failed,
      // That verifier exits non-zero for leftover markers and for its own failure, so both are
      // named rather than guessed at; the output below says which one it was.
      summary: result.ok
        ? `clean (${verifier} --verify)`
        : `${verifier} --verify failed (exit ${result.code ?? 'did not run'}): either markers remain or the verifier itself failed`,
      details: result.ok ? [] : headText(`${result.stdout}\n${result.stderr}`, 20)
    }
  }
  const dirs = MARKER_DIRS.filter((dir) => existsSync(path.join(repoRoot(), dir)))
  const result = git(['grep', '--untracked', '-I', '-n', '-E', MARKER_PATTERN, '--', ...dirs])
  // git grep exits 1 for "no match", which is the pass case; anything else is a real error.
  if (!result.ok && result.code !== 1) {
    return {
      status: STATUS.failed,
      summary: `the marker scan could not run (exit ${result.code ?? 'did not run'})`,
      details: tailText(result.stderr)
    }
  }
  const hits = result.stdout.split('\n').filter(Boolean)
  const method = delegate
    ? `${verifier} is not available, so this is a direct scan of ${dirs.join(', ')}`
    : `direct scan of ${dirs.join(', ')}`
  return {
    status: hits.length === 0 ? STATUS.passed : STATUS.failed,
    summary: hits.length === 0 ? `clean (${method})` : `${hits.length} marker line(s)`,
    details: hits.slice(0, 20)
  }
}

// The catalog is a derived file: regenerated from the source catalog, never merged. Both tools
// run the generator and then assert that it changed nothing, which is the same provenance check
// at the two points the runbook makes it.
export function localizationCatalog() {
  if (!existsSync(path.join(repoRoot(), CATALOG))) {
    return { status: STATUS.failed, summary: `${CATALOG} is missing`, details: [] }
  }
  const generated = run(pnpmCommand(), ['run', 'sync:localization-runtime-catalog'], {
    cwd: repoRoot()
  })
  if (!generated.ok) {
    return {
      status: STATUS.failed,
      summary: `pnpm run sync:localization-runtime-catalog failed (exit ${generated.code ?? 'did not run'})`,
      details: tailText(`${generated.stdout}\n${generated.stderr}`, 20)
    }
  }
  const diff = git(['diff', '--quiet', '--', CATALOG])
  const staged = (gitText(['status', '--porcelain', '--', CATALOG]) ?? '').trim()
  const clean = diff.ok && staged === ''
  return {
    status: clean ? STATUS.passed : STATUS.failed,
    summary: clean
      ? 'regenerates to no diff'
      : `git diff --quiet is ${diff.ok ? 'clean, but the index is not' : 'non-empty'}`,
    details: staged ? [`git status --porcelain: ${staged}`] : []
  }
}

/** Repo-wide oxlint — the same command the CI lint step runs.
 *
 *  Why it belongs here: the changed-lines gate only ever looks at a PR's own diff, so a merge
 *  resolution that pushes a file past `max-lines` (or trips a naming rule) lands unnoticed and is
 *  inherited by the next PR that touches that file. The np.18 sync left six such files behind,
 *  and a later unrelated change inherited all of them. */
export function repoLint() {
  const result = run(pnpmCommand(), ['exec', 'oxlint'], { cwd: repoRoot() })
  return {
    status: result.ok ? STATUS.passed : STATUS.failed,
    summary: result.ok ? 'clean' : `failed (exit ${result.code ?? 'did not run'})`,
    details: result.ok ? [] : tailText(`${result.stdout}\n${result.stderr}`, 40)
  }
}

export function typecheck(options) {
  if (options.skipTypecheck) {
    return { status: STATUS.skipped, summary: 'skipped by --skip-typecheck', details: [] }
  }
  const result = run(pnpmCommand(), ['tc'], { cwd: repoRoot() })
  return {
    status: result.ok ? STATUS.passed : STATUS.failed,
    summary: result.ok ? 'clean' : `failed (exit ${result.code ?? 'did not run'})`,
    details: result.ok ? [] : tailText(`${result.stdout}\n${result.stderr}`, 40)
  }
}
