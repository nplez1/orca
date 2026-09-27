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
function spec({ file, title, status, error, stepTitle, expectedStatus = 'passed' }) {
  const result = { status, steps: stepTitle ? [{ title: stepTitle, steps: [] }] : [] }
  if (error) {
    result.error = { message: error }
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

function run(report, titles) {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'))
  dirs.push(dir)
  const reportPath = join(dir, 'report.json')
  const titlesPath = join(dir, 'titles.json')
  writeFileSync(reportPath, JSON.stringify(report))
  writeFileSync(titlesPath, JSON.stringify({ titles }))
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, reportPath, titlesPath], {
      encoding: 'utf8'
    })
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
      observedUpstreamRuns: 8
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
    titles
  )
  expect(recorded.status).toBe(0)
  expect(recorded.stdout).toContain('::notice::known failure (upstream)')
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
    titles
  )
  expect(unrecorded.status).toBe(1)
  expect(unrecorded.stdout).toContain('::error::unexpected E2E failure')
})

it('fails when the report is missing, so a crashed run cannot pass as green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'))
  dirs.push(dir)
  const titlesPath = join(dir, 'titles.json')
  writeFileSync(titlesPath, JSON.stringify({ titles: [] }))
  const result = run({}, [])
  expect(result.status).toBe(0)
  let failed = false
  try {
    execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json'), titlesPath], {
      stdio: 'pipe'
    })
  } catch (error) {
    failed = true
    expect(String(error.stderr)).toContain('cannot read')
  }
  expect(failed).toBe(true)
})
