// Runs the unit suite and its isolation re-runs, and reports what each step did: every spawn the
// gate makes, kept apart from `gate-unit.mjs`, which decides what the resulting report means. Why
// apart: that file is at its line budget, and the exit composition is what a test has to reach.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NO_RERUN, rerunReportsFor } from './unit-gate-judgement.mjs'

const ROOT = resolve(import.meta.dirname, '..')
/** Why this switch: the unit and PR workflows set it, and it is what makes `config/vitest.config.ts`
 *  apply upstream's `UNIT_EXCLUDE` instead of `defaultExclude`. */
const UNIT_LANE_ENV = { ORCA_BALANCE_UNIT_SHARDS: '1' }
/** Why: `config/vitest.config.ts` records dependencies only when `CI` is unset, so upstream's lane runs
 *  without it. With it on, an upstream fire-and-forget `import()` still pending when a file ends is
 *  reported as `EnvironmentTeardownError: Cannot load …` against the next file (LOCAL-PATCHES.md,
 *  2026-10-25 sync). Narrower than setting `CI`, which other suites read for their own behaviour. */
const UNIT_LANE_ARGS = ['--experimental.recordDependencies=false']
/** Why: an agent session inherits the app's own WSL gate state, and `isWslHostsServing` trusts an
 *  inherited value over the gate env. The store's fail-closed cases then invert and their three tests
 *  red — reproduced in isolation, green with this var cleared. A verdict must not depend on which
 *  shell started the gate, so the suite runs in a neutral gate. */
const INHERITED_APP_ENV = ['ORCA_WSL_HOSTS_GATE_STATE', 'ORCA_INTERNAL_WSL_HOSTS']
/** `local/` is outside `UNIT_INCLUDE` by upstream's definition, so nothing else would run these. */
const FORK_TEST_TIMEOUT_MS = 5 * 60 * 1000
const RUN_VITEST = join(ROOT, 'config', 'scripts', 'run-vitest.mjs')

function childEnv(env) {
  // Why the merge rather than a bare env: PATH and the Bun pin have to survive the overlay.
  const merged = env ? { ...process.env, ...env } : { ...process.env }
  for (const name of INHERITED_APP_ENV) {
    delete merged[name]
  }
  return merged
}

function runStep(label, program, args, logFd, timeoutMs, env) {
  process.stderr.write(`gate-unit: ${label}\n`)
  const started = Date.now()
  const result = spawnSync(program, args, {
    cwd: ROOT,
    env: childEnv(env),
    stdio: ['ignore', logFd, logFd],
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  })
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
  // Why the error: a spawn that never started (ENOENT, EACCES) has a null status, which would
  // otherwise read as a clean exit of zero. `timedOut` is the one error that has its own outcome.
  return {
    status: result.status,
    timedOut,
    error: timedOut ? null : (result.error?.message ?? null),
    elapsedMs: Date.now() - started
  }
}

export function runSuite({ reportPath, logPath, timeoutMs, vitestArgs, forkTests }) {
  const logFd = openSync(logPath, 'w')
  let elapsedMs = 0
  let forkTestsPassed = true
  try {
    // Why first: it costs a second and its failure would invalidate any verdict the suite produced.
    // Why its own deadline: a hung sync test must not cost the suite's whole hour before it starts.
    const forkStep =
      forkTests.length === 0
        ? { status: 0, timedOut: false, elapsedMs: 0 }
        : runStep(
            'fork-local tests',
            process.execPath,
            ['--test', ...forkTests],
            logFd,
            Math.min(timeoutMs, FORK_TEST_TIMEOUT_MS)
          )
    elapsedMs += forkStep.elapsedMs
    if (forkStep.timedOut) {
      return { outcome: 'timed-out', elapsedMs, forkTestsPassed: false }
    }
    if (forkStep.error) {
      return {
        outcome: `fork-local tests could not run: ${String(forkStep.error)}`,
        elapsedMs,
        forkTestsPassed: false
      }
    }
    if (forkStep.status !== 0) {
      return { outcome: 'fork-local tests failed', elapsedMs, forkTestsPassed: false }
    }
    // Why objects: a heterogeneous tuple array widens `label` to `string | string[]` under the
    // fork's type-aware lint, which then rejects it inside the failure template.
    for (const preparation of [
      { label: 'build:packages', program: 'pnpm', args: ['run', 'build:packages'] },
      {
        label: 'ensure native runtime',
        program: 'node',
        args: [join(ROOT, 'config', 'scripts', 'ensure-native-runtime.mjs'), '--runtime=node']
      }
    ]) {
      const step = runStep(
        preparation.label,
        preparation.program,
        preparation.args,
        logFd,
        timeoutMs
      )
      elapsedMs += step.elapsedMs
      if (step.timedOut) {
        return { outcome: 'timed-out', elapsedMs, forkTestsPassed }
      }
      if (step.error) {
        return {
          outcome: `${preparation.label} could not run: ${String(step.error)}`,
          elapsedMs,
          forkTestsPassed
        }
      }
      if (step.status !== 0) {
        return { outcome: `${preparation.label} failed`, elapsedMs, forkTestsPassed }
      }
    }
    // Why the cap line: the doubling this gate once showed (2,575 s against a 1,400 s baseline) was
    // a worker cap inherited from the shell, and a run log that named it would have said so in one
    // line instead of a per-file concurrency reconstruction.
    if (process.env.VITEST_MAX_WORKERS !== undefined) {
      process.stderr.write(`gate-unit: VITEST_MAX_WORKERS=${process.env.VITEST_MAX_WORKERS}\n`)
    }
    const suite = runStep(
      'full unit suite',
      'node',
      [
        RUN_VITEST,
        'run',
        '--config',
        'config/vitest.config.ts',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        ...UNIT_LANE_ARGS,
        ...vitestArgs
      ],
      logFd,
      timeoutMs,
      UNIT_LANE_ENV
    )
    elapsedMs += suite.elapsedMs
    if (suite.timedOut) {
      return { outcome: 'timed-out', elapsedMs, forkTestsPassed }
    }
    if (suite.error) {
      return {
        outcome: `the full unit suite could not run: ${String(suite.error)}`,
        elapsedMs,
        forkTestsPassed
      }
    }
    return { outcome: 'complete', status: suite.status, elapsedMs, forkTestsPassed }
  } finally {
    closeSyncSafe(logFd)
  }
}

function closeSyncSafe(fd) {
  try {
    closeSync(fd)
  } catch {
    // The descriptor is already closed when a step threw before the suite started.
  }
}

/**
 * One isolated re-run of every unexpected file in a single Vitest invocation, reported per file as
 * the tests that passed and failed inside it. Batched so N failing files pay one cold start instead
 * of N serial ones; each file still runs in its own worker, and the report is filtered by exact
 * path, so the per-file attribution of a serial re-run is unchanged.
 *
 * Why per test rather than per file: the file's own allowlisted reds still fail when it re-runs with
 * its siblings, so "the file exited non-zero" cannot tell a load flake from a real break once entries
 * are named. A missing report is not evidence of anything, so it reads as "every failure reproduced".
 */
export function rerunIsolation(files, dir, timeoutMs) {
  if (files.length === 0) {
    return new Map()
  }
  const reportPath = join(dir, 'isolation-report.json')
  const logFd = openSync(join(dir, 'isolation.log'), 'a')
  try {
    const step = runStep(
      `isolation re-run ${files.length} file(s)`,
      'node',
      [
        RUN_VITEST,
        'run',
        '--config',
        'config/vitest.config.ts',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        ...UNIT_LANE_ARGS,
        ...files
      ],
      logFd,
      timeoutMs,
      UNIT_LANE_ENV
    )
    if (step.timedOut || !existsSync(reportPath)) {
      return new Map(files.map((file) => [file, NO_RERUN]))
    }
    try {
      return rerunReportsFor(JSON.parse(readFileSync(reportPath, 'utf8')), files)
    } catch {
      // Why not readJsonFile: that exits the process, losing the summary this verdict is for.
      return new Map(files.map((file) => [file, NO_RERUN]))
    }
  } finally {
    closeSyncSafe(logFd)
  }
}
