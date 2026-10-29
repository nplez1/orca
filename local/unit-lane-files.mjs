// What the unit gate's lane collects, apart from the process that runs it: the set a report is
// checked against and the files upstream quarantines. `gate-unit.mjs` is at its line budget, and
// these are facts about the repository rather than about the run.
import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { UNIT_EXCLUDE, UNIT_INCLUDE } from '../config/scripts/ci-unit-files.mjs'

const ROOT = resolve(import.meta.dirname, '..')

/** `local/` is outside `UNIT_INCLUDE` by upstream's definition, so nothing else would run these. */
export const FORK_TEST_INCLUDE = ['local/**/*.test.mjs']

function normalise(name) {
  return String(name ?? '').replaceAll('\\', '/')
}

/** Every file the gate's own lane should collect: `UNIT_INCLUDE` with `UNIT_EXCLUDE` applied. */
export function runnableFiles(root = ROOT) {
  return globSync(UNIT_INCLUDE, { cwd: root, exclude: UNIT_EXCLUDE }).map(normalise).sort()
}

/**
 * Files `UNIT_INCLUDE` collects but `UNIT_EXCLUDE` drops. Upstream's unit lane does not run them
 * either, so a red there is not this fork's to record — but a gate that quietly stopped applying the
 * exclusion would look green for the wrong reason, which is why the run is checked against this list.
 */
export function quarantinedFiles(root = ROOT) {
  const runnable = new Set(runnableFiles(root))
  return globSync(UNIT_INCLUDE, { cwd: root })
    .map(normalise)
    .filter((file) => !runnable.has(file))
    .sort()
}

export function forkTestFiles(root = ROOT) {
  return globSync(FORK_TEST_INCLUDE, { cwd: root, exclude: ['**/node_modules/**'] })
    .map(normalise)
    .sort()
}
