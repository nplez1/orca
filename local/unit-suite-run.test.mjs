// The three ways the fork-local step of a gate run can end without a verdict: the spawn never started,
// it was killed at its deadline, and it ran and failed. Each has to come back as its own outcome, because
// `gate-unit.mjs` prints the outcome and a null status otherwise reads as a clean exit of zero.
//
//   node --test local/unit-suite-run.test.mjs
//
// Every case ends at the fork step, so none of them reaches `pnpm run build:packages` or the suite. The
// fixtures are written outside the repo on purpose: `local/**/*.test.mjs` is what the real lane globs, and
// a deliberately failing fixture inside it would turn the lane red.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runSuite } from './unit-suite-run.mjs'

const PASSING = "import test from 'node:test'\ntest('passes', () => {})\n"
const FAILING =
  "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fails', () => { assert.fail('deliberate') })\n"
const HANGING =
  "import test from 'node:test'\ntest('hangs', () => new Promise((resolve) => setTimeout(resolve, 30_000)))\n"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-unit-suite-run-'))
  const fixture = (name, source) => {
    const file = join(dir, name)
    writeFileSync(file, source)
    return file
  }
  return { dir, reportPath: join(dir, 'report.json'), logPath: join(dir, 'run.log'), fixture }
}

function gateRun({ timeoutMs = 10_000, forkTests, deps } = {}) {
  const { reportPath, logPath, fixture } = scratch()
  return {
    fixture,
    run: (files) =>
      runSuite(
        { reportPath, logPath, timeoutMs, vitestArgs: [], forkTests: files ?? forkTests },
        deps
      )
  }
}

test('a fork program that cannot start is reported, not read as a clean exit', () => {
  const { run, fixture } = gateRun({ deps: { forkProgram: '/nonexistent/orca-node' } })
  const result = run([fixture('passing.test.mjs', PASSING)])
  assert.match(result.outcome, /^fork-local tests could not run: /)
  assert.match(result.outcome, /ENOENT/)
  assert.equal(result.forkTestsPassed, false)
})

test('a fork step killed at its deadline reports a timeout, not a pass', () => {
  const { run, fixture } = gateRun({ timeoutMs: 250 })
  const result = run([fixture('hanging.test.mjs', HANGING)])
  assert.equal(result.outcome, 'timed-out')
  assert.equal(result.forkTestsPassed, false)
})

test('a fork step that ran and failed names the step, not the suite', () => {
  const { run, fixture } = gateRun()
  const result = run([fixture('failing.test.mjs', FAILING)])
  assert.equal(result.outcome, 'fork-local tests failed')
  assert.equal(result.forkTestsPassed, false)
})
