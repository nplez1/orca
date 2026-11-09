import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  collectOutcomes,
  judge,
  specKey,
  titleKeys
} from '../../local/check-e2e-known-failure-titles.mjs'

const SCRIPT = new URL('../../local/check-e2e-known-failure-titles.mjs', import.meta.url).pathname
const STEP_TITLE = 'keys pressed in the split browser chrome'

/**
 * Mirrors the JSON reporter's shape: `test.status` is an outcome category, the run status lives in
 * `results[].status`, and `spec.ok` is false only for an `unexpected` outcome.
 */
function spec({
  file,
  title,
  status,
  error,
  stepTitle,
  expectedStatus = 'passed',
  neverRan = false
}) {
  const result = { status, steps: stepTitle ? [{ title: stepTitle, steps: [] }] : [] }
  if (error) {
    result.error = { message: error }
  }
  // A spec Playwright never started: the suite reports it with no results at all and no failure, which
  // is exactly the shape that used to read as neither failed nor passed.
  if (neverRan) {
    return {
      file,
      title,
      line: 94,
      column: 7,
      ok: true,
      tests: [{ status: 'skipped', expectedStatus, results: [] }]
    }
  }
  const testStatus = expectedStatus === 'passed' && status !== 'passed' ? 'unexpected' : 'expected'
  return {
    file,
    title,
    line: 94,
    column: 7,
    ok: testStatus === 'expected',
    tests: [{ status: testStatus, expectedStatus, results: [result] }]
  }
}

/** Mirrors the JSON reporter's shape: one top-level suite per file, describes nested inside it. */
function fileSuite(file, { specs = [], describes = [] }) {
  return {
    title: file,
    specs,
    suites: describes.map(([title, describeSpecs]) => ({ title, specs: describeSpecs, suites: [] }))
  }
}

const dirs = []

function run(report, titles, outcome = 'success', { selected = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const titlesPath = join(dir, 'titles.json')
  writeFileSync(reportPath, JSON.stringify(report))
  writeFileSync(titlesPath, JSON.stringify({ titles }))
  const args = [SCRIPT, reportPath, titlesPath, outcome]
  if (selected !== null) {
    const selectedPath = join(dir, 'selected.txt')
    writeFileSync(selectedPath, selected)
    args.push('--selected', selectedPath)
  }
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keys a spec the way the failure log names it', () => {
  expect(specKey({ file: 'tabs.spec.ts', title: 'New tab works' }, ['tabs.spec.ts'])).toBe(
    'tests/e2e/tabs.spec.ts › New tab works'
  )
  expect(
    specKey({ file: 'native-chat-message-rail.spec.ts', title: 'previews prompts' }, [
      'native-chat-message-rail.spec.ts',
      'Native chat message rail'
    ])
  ).toBe('tests/e2e/native-chat-message-rail.spec.ts › Native chat message rail › previews prompts')
})

it('resolves a title recorded from a failure that died inside a test step', () => {
  const outcomes = collectOutcomes({
    suites: [
      fileSuite('browser-floating-shortcut-scope.spec.ts', {
        describes: [
          [
            'floating browser shortcut scope',
            [
              spec({
                file: 'browser-floating-shortcut-scope.spec.ts',
                title: 'chrome shortcuts act only in the pane that owns the key press',
                status: 'failed',
                error: 'expect(received).toBe(expected) // Object.is equality',
                stepTitle: STEP_TITLE
              })
            ]
          ]
        ]
      })
    ],
    errors: []
  })
  const known = titleKeys({
    titles: [
      {
        file: 'tests/e2e/browser-floating-shortcut-scope.spec.ts',
        title: `floating browser shortcut scope › chrome shortcuts act only in the pane that owns the key press › ${STEP_TITLE}`
      }
    ]
  })
  const verdict = judge(known, outcomes)
  expect(verdict.quarantined.map(([key]) => key)).toEqual([
    'tests/e2e/browser-floating-shortcut-scope.spec.ts › floating browser shortcut scope › chrome shortcuts act only in the pane that owns the key press'
  ])
  expect(verdict.unexpected).toHaveLength(0)
})

it('does not count a test.fail() case that failed as an unexpected failure', () => {
  const outcomes = collectOutcomes({
    suites: [
      fileSuite('tabs.spec.ts', {
        specs: [
          spec({
            file: 'tabs.spec.ts',
            title: 'documents a known bug',
            status: 'failed',
            error: 'expected failure',
            expectedStatus: 'failed'
          })
        ]
      })
    ],
    errors: []
  })
  expect(outcomes.failures.size).toBe(0)
  const verdict = judge(titleKeys({ titles: [] }), outcomes)
  expect(verdict.unexpected).toHaveLength(0)
  expect(verdict.stale).toHaveLength(0)
})

it('reports an unrecorded failure as unexpected and a passing entry as stale', () => {
  const outcomes = collectOutcomes({
    suites: [
      fileSuite('tabs.spec.ts', {
        specs: [
          spec({ file: 'tabs.spec.ts', title: 'New tab works', status: 'failed', error: 'boom' }),
          spec({ file: 'tabs.spec.ts', title: 'closes a tab', status: 'passed' })
        ]
      })
    ],
    errors: []
  })
  const known = titleKeys({
    titles: [
      { file: 'tests/e2e/tabs.spec.ts', title: 'closes a tab' },
      { file: 'tests/e2e/other.spec.ts', title: 'lives in another shard' }
    ]
  })
  const verdict = judge(known, outcomes)
  expect(verdict.unexpected.map(([key]) => key)).toEqual(['tests/e2e/tabs.spec.ts › New tab works'])
  expect(verdict.stale).toEqual(['tests/e2e/tabs.spec.ts › closes a tab'])
})

it('exits 0 for a recorded failure and 1 for an unrecorded one', () => {
  const titles = [
    {
      file: 'tests/e2e/tabs.spec.ts',
      title: 'New tab works',
      owner: 'upstream',
      observedForkRuns: 12,
      observedUpstreamRuns: 8,
      match: '^boom$'
    }
  ]
  const recorded = run(
    {
      suites: [
        fileSuite('tabs.spec.ts', {
          specs: [
            spec({ file: 'tabs.spec.ts', title: 'New tab works', status: 'failed', error: 'boom' })
          ]
        })
      ],
      errors: []
    },
    titles,
    'failure'
  )
  expect(recorded.status).toBe(0)
  expect(recorded.stdout).toContain('::notice::known failure (upstream)')
  // Why the counts: the notice line is the evidence for the entry, so a trimmed entry printing
  // `undefined fork / undefined upstream` would erase it.
  expect(recorded.stdout).toContain('in 12 fork / 8 upstream sampled run(s)')
  expect(recorded.stdout).toContain('1 known, 0 unexpected')

  const unrecorded = run(
    {
      suites: [
        fileSuite('tabs.spec.ts', {
          specs: [
            spec({
              file: 'tabs.spec.ts',
              title: 'New tab works differently',
              status: 'failed',
              error: 'boom'
            })
          ]
        })
      ],
      errors: []
    },
    titles,
    'failure'
  )
  expect(unrecorded.status).toBe(1)
  expect(unrecorded.stdout).toContain('::error::unexpected E2E failure')
})

it('fails when the report is missing, so a crashed run cannot pass as green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'))
  dirs.push(dir)
  const titlesPath = join(dir, 'titles.json')
  writeFileSync(titlesPath, JSON.stringify({ titles: [] }))
  // A report with no spec in it proves nothing, whatever the run step said.
  const empty = run({}, [], 'success')
  expect(empty.status).toBe(1)
  expect(empty.stdout).toContain('holds no specs')
  let failed = false
  try {
    execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json'), titlesPath, 'success'], {
      stdio: 'pipe'
    })
  } catch (error) {
    failed = true
    expect(String(error.stderr)).toContain('cannot read')
  }
  expect(failed).toBe(true)
})

it('judges the step outcome, so a failure nothing explains cannot pass', () => {
  const titles = []
  const clean = {
    suites: [
      fileSuite('tabs.spec.ts', {
        specs: [spec({ file: 'tabs.spec.ts', title: 'x', status: 'passed' })]
      })
    ],
    errors: []
  }
  expect(run(clean, titles, 'success').status).toBe(0)
  const failedRun = run(clean, titles, 'failure')
  expect(failedRun.status).toBe(1)
  expect(failedRun.stdout).toContain('neither the report nor a recorded failure explains it')
  const unknownOutcome = run(clean, titles, 'cancelled')
  expect(unknownOutcome.status).toBe(1)
  expect(unknownOutcome.stdout).toContain('unknown test-step outcome "cancelled"')
})

it('needs the step outcome as an argument, so a run cannot be judged without one', () => {
  let failure = null
  try {
    execFileSync(process.execPath, [SCRIPT, 'report.json', 'titles.json'], { stdio: 'pipe' })
  } catch (error) {
    failure = error
  }
  expect(failure?.status).toBe(2)
  expect(String(failure?.stderr)).toContain('OUTCOME')
})

// --- #317: the selected-spec check, and a cause on every recorded title -------------------------

const recorded = (overrides = {}) => ({
  file: 'tests/e2e/tabs.spec.ts',
  title: 'New tab works',
  owner: 'upstream',
  observedForkRuns: 4,
  observedUpstreamRuns: 2,
  match: '^expect\\(received\\)\\.toBe\\(expected\\)',
  ...overrides
})

const tabsReport = (specOverrides) => ({
  suites: [
    fileSuite('tabs.spec.ts', {
      specs: [
        spec({
          file: 'tabs.spec.ts',
          title: 'New tab works',
          status: 'failed',
          error: 'Error: expect(received).toBe(expected) // Object.is equality',
          ...specOverrides
        })
      ]
    })
  ],
  errors: []
})

it('fails a selected spec that produced no result at all (#317)', () => {
  // The shape an interrupted Playwright run leaves: the spec was selected, it never started, and
  // nothing in the report says so — which is how a run with one known failure could still pass.
  const verdict = run(tabsReport({ neverRan: true }), [recorded()], 'failure', {
    selected: 'tabs.spec.ts\n'
  })
  expect(verdict.status).toBe(1)
  expect(verdict.stdout).toContain('selected spec never ran')
  expect(verdict.stdout).toContain('none of its tests declared a skip')
})

it('accepts a selected spec whose tests declare a skip, because 179 spec files do that', () => {
  const verdict = run(
    tabsReport({ neverRan: true, expectedStatus: 'skipped' }),
    [recorded()],
    'success',
    { selected: 'tabs.spec.ts\n' }
  )
  expect(verdict.status).toBe(0)
  expect(verdict.stdout).not.toContain('selected spec never ran')
})

it('fails when a selected spec file is absent from the report', () => {
  const verdict = run(tabsReport(), [recorded()], 'failure', {
    selected: 'tabs.spec.ts\nother.spec.ts\n'
  })
  expect(verdict.status).toBe(1)
  expect(verdict.stdout).toContain('selected spec file never ran: tests/e2e/other.spec.ts')
})

it('fails when the report names a spec file the shard was not selected to run', () => {
  const verdict = run(tabsReport(), [recorded()], 'failure', { selected: 'other.spec.ts\n' })
  expect(verdict.status).toBe(1)
  expect(verdict.stdout).toContain('was not selected to run: tests/e2e/tabs.spec.ts')
})

it('fails when the named selection cannot be read, and when it is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const titlesPath = join(dir, 'titles.json')
  writeFileSync(reportPath, JSON.stringify(tabsReport()))
  writeFileSync(titlesPath, JSON.stringify({ titles: [recorded()] }))
  const attempt = (selectedPath) => {
    try {
      execFileSync(
        process.execPath,
        [SCRIPT, reportPath, titlesPath, 'failure', '--selected', selectedPath],
        {
          encoding: 'utf8'
        }
      )
      return { status: 0, stdout: '' }
    } catch (error) {
      return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
    }
  }
  const missing = attempt(join(dir, 'absent.txt'))
  expect(missing.status).toBe(1)
  expect(missing.stderr).toContain('cannot read the selection')
  const emptyPath = join(dir, 'empty.txt')
  writeFileSync(emptyPath, '\n\n')
  const empty = attempt(emptyPath)
  expect(empty.status).toBe(1)
  expect(empty.stderr).toContain('names no spec file')
})

it('reports a listed spec that failed for a new cause as its own problem (#317)', () => {
  const verdict = run(
    tabsReport({ error: 'Error: TypeError: totally new bug' }),
    [recorded()],
    'failure',
    { selected: 'tabs.spec.ts\n' }
  )
  expect(verdict.status).toBe(1)
  expect(verdict.stdout).toContain('listed spec failed for a new cause')
  expect(verdict.stdout).toContain('TypeError: totally new bug')
})

it('refuses a recorded title that can neither pin a cause nor say it is flaky', () => {
  const withoutMatch = recorded()
  delete withoutMatch.match
  const verdict = run(tabsReport(), [withoutMatch], 'failure', { selected: 'tabs.spec.ts\n' })
  expect(verdict.status).toBe(1)
  expect(verdict.stdout).toContain('has no match and is not flaky')
})

it('lets a flaky title absorb any cause, which is what an intermittent upstream red needs', () => {
  const flaky = recorded({ flaky: true })
  delete flaky.match
  const verdict = run(
    tabsReport({ error: 'Error: whatever it was this time' }),
    [flaky],
    'failure',
    {
      selected: 'tabs.spec.ts\n'
    }
  )
  expect(verdict.status).toBe(0)
  expect(verdict.stdout).toContain('1 known, 0 unexpected')
})
