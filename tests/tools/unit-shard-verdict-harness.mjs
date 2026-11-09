// Fixtures for the shard verdict's two suites: the judgement over a report/log pair, and the
// assignment input that says which files the shard owed. Kept here rather than in either suite so
// both judge the same report shape and neither grows past the 600-line cap for `.mjs`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideUnitShardVerdict } from '../../local/check-unit-shard-verdict.mjs'

export const SCRIPT = new URL('../../local/check-unit-shard-verdict.mjs', import.meta.url).pathname
// Verbatim what Vitest's pool prints, and the entry the Linux manifest tolerates it with.
export const POOL_CRASH = 'Error: [vitest-pool]: Worker node-runtime emitted error.'
export const POOL_CRASH_ENTRY = {
  match: '^Error: \\[vitest-pool\\]: Worker node-runtime emitted error\\.$',
  class: 'pool-crash',
  explainsFailure: false
}
export const CANCELED = 'Canceled: Canceled'
export const CANCELED_ENTRY = { match: '^Canceled: Canceled$', class: 'third-party-teardown' }

const dirs = []

/** Each suite registers this as its `afterEach`, so a temp manifest never outlives its test. */
export function cleanupTempDirs() {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unit-shard-verdict-'))
  dirs.push(dir)
  return dir
}

export function report({
  totalTests = 100,
  failedTests = 0,
  failedSuites = 0,
  failing = [],
  passing = [],
  fileLevelFailures = []
} = {}) {
  return JSON.stringify({
    numTotalTestSuites: failedSuites + passing.length + fileLevelFailures.length + 1,
    numFailedTestSuites: failedSuites + fileLevelFailures.length,
    numTotalTests: totalTests,
    numFailedTests: failedTests,
    success: failedTests === 0 && failedSuites === 0,
    testResults: [
      ...failing.map(([name, fullName, message]) => ({
        name,
        status: 'failed',
        ...(message ? { message } : {}),
        assertionResults: [{ status: 'failed', title: fullName, fullName }]
      })),
      ...passing.map(([name, fullName = 'passes']) => ({
        name,
        status: 'passed',
        assertionResults: [{ status: 'passed', title: fullName, fullName }]
      })),
      ...fileLevelFailures.map((name) => ({ name, status: 'failed', assertionResults: [] }))
    ]
  })
}

export function log({ errors = [], declaredCount = errors.length } = {}) {
  if (declaredCount === 0) {
    return ' Test Files  1192 passed (1204)\n      Tests  12231 passed (12313)\n'
  }
  const blocks = errors
    .map(
      (headline) =>
        `\u2500\u2500\u2500\u2500\u2500\u2500 Unhandled Rejection \u2500\u2500\u2500\u2500\u2500\u2500\n` +
        `\u001b[31m\u001b[1m${headline}\u001b[22m\u001b[39m\n` +
        `This error originated in "src/main/ipc/worktrees-detected-scan-cache.test.ts" test file.`
    )
    .join('\n')
  return (
    `\u2500\u2500\u2500\u2500\u2500\u2500 Unhandled Errors \u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `Vitest caught ${declaredCount} unhandled error${declaredCount === 1 ? '' : 's'} during the test run.\n` +
    `This might cause false positive tests.\n${blocks}\n` +
    ` Test Files  1192 passed (1204)\n      Tests  12231 passed (12313)\n     Errors  ${declaredCount} error\n`
  )
}

export const decide = (overrides = {}) =>
  decideUnitShardVerdict({
    reportText: report(),
    logText: log(),
    outcome: 'success',
    ...overrides
  })

export function run(
  reportText,
  logText,
  outcome,
  knownRed = [],
  { unhandledErrors = [], assignment = null, env = {} } = {}
) {
  const dir = tempDir()
  const reportPath = join(dir, 'report.json')
  const logPath = join(dir, 'shard.log')
  // Why always written, even when empty: otherwise a run on Linux falls back to the repo's real
  // manifest and the test means something different on CI than it does here.
  const knownRedPath = join(dir, 'known-red.json')
  writeFileSync(reportPath, reportText)
  writeFileSync(logPath, logText)
  writeFileSync(knownRedPath, JSON.stringify({ entries: knownRed, unhandledErrors }))
  const args = [SCRIPT, reportPath, logPath, outcome, '--known-red', knownRedPath]
  if (assignment !== null) {
    const assignmentPath = join(dir, 'unit-assignment.json')
    writeFileSync(
      assignmentPath,
      typeof assignment === 'string' ? assignment : JSON.stringify(assignment)
    )
    args.push('--assignment', assignmentPath)
  }
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env, ...env }
      })
    }
  } catch (error) {
    return { status: error.status, stdout: `${error.stdout}${error.stderr}` }
  }
}

export function runRaw(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    }
  } catch (error) {
    return { status: error.status, stdout: `${error.stdout}${error.stderr}` }
  }
}
