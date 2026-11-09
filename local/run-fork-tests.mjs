#!/usr/bin/env node
/**
 * The fork's own `node --test` files, as one command a CI lane can run.
 *
 * These files live outside `UNIT_INCLUDE`, so no unit lane collects them: before this, the only thing that
 * ran them was `local/gate-unit.mjs`'s fork step, i.e. a hand-run release gate. A broken `local/sync/lib`
 * assertion could therefore sit on the release line indefinitely.
 *
 * Why a script and not the glob in the workflow: `node --test` given the quoted glob exits 0 when the
 * pattern matches nothing, and a shell expands a doubled star as a single one without globstar. A lane
 * that can prove nothing
 * by matching nothing is the failure class this lane exists to catch, so an empty match is exit 2 here —
 * the same refusal `gate-unit.mjs` makes for its fork step.
 *
 * Usage: node local/run-fork-tests.mjs [--list]
 *
 * Exit: 0 pass, 1 a test failed, 2 nothing matched or the run could not start.
 */
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
/** Why the same literal as `gate-unit.mjs`: both run these files, and `check-test-file-runners` pins it. */
export const FORK_TEST_INCLUDE = ['local/**/*.test.mjs']

export function forkTestFiles(root = ROOT) {
  return globSync(FORK_TEST_INCLUDE, { cwd: root, exclude: ['**/node_modules/**'] })
    .map((file) => String(file).replaceAll('\\', '/'))
    .sort()
}

function main(argv) {
  const files = forkTestFiles()
  if (files.length === 0) {
    console.error(
      `no test file matched ${FORK_TEST_INCLUDE.join(', ')}, so this lane proved nothing`
    )
    return 2
  }
  if (argv.includes('--list')) {
    console.log(files.join('\n'))
    return 0
  }
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' })
  if (result.error) {
    console.error(`the fork-local tests could not run: ${result.error.message}`)
    return 2
  }
  // Why `?? 2`: a run killed by a signal has a null status, which must not read as a pass.
  return result.status ?? 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
