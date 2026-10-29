import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKS,
  ISSUE_TITLE,
  MARKER,
  decideAction,
  findOpenIssue,
  judgeHealth
} from '../../local/ci-health-report.mjs'
import { REPO_ROOT, readWorkflow, runScripts, triggerKeys } from './workflow-file.mjs'

const check = (name, code, output = `${name} output`) => ({ name, code, output })
const clean = () => [check('check-actions-enablement', 0), check('check-nightly-liveness', 0)]

describe('health verdict', () => {
  it('is clean only when both checks are clean', () => {
    expect(judgeHealth(clean())).toMatchObject({ ok: true, code: 0, title: ISSUE_TITLE })
  })

  it('names the failing check and quotes what it said', () => {
    const verdict = judgeHealth([
      check('check-actions-enablement', 1, '  DRIFT    active but not on the fork list: x.yml'),
      check('check-nightly-liveness', 0)
    ])

    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.body).toContain('`check-actions-enablement` — exit 1')
    expect(verdict.body).toContain('DRIFT    active but not on the fork list: x.yml')
    expect(verdict.body).not.toContain('`check-nightly-liveness` — exit 1')
  })

  it('does not read "could not tell" as a pass', () => {
    const verdict = judgeHealth([
      check('check-actions-enablement', 0),
      check('check-nightly-liveness', 2, 'nightly liveness: cannot tell — gh is not installed')
    ])

    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe(1)
    expect(verdict.body).toContain('"Could not tell" is not a pass')
  })

  it('answers 2 when every check could not tell', () => {
    const verdict = judgeHealth([
      check('check-actions-enablement', 2),
      check('check-nightly-liveness', 2)
    ])

    expect(verdict).toMatchObject({ ok: false, code: 2 })
  })

  it('points a red nightly at the triage rule and the red-set file', () => {
    const verdict = judgeHealth([
      check('check-actions-enablement', 0),
      check('check-nightly-liveness', 1)
    ])

    expect(verdict.body).toContain('local/nightly-linux-known-red.json')
    expect(verdict.body).toContain('node local/check-nightly-liveness.mjs --json')
  })

  it('carries the marker and the run link, so a hand-edited issue is still recognisable', () => {
    const verdict = judgeHealth(clean(), { runUrl: 'https://example.test/run/1' })

    expect(verdict.body.startsWith(MARKER)).toBe(true)
    expect(verdict.body).toContain('Run: https://example.test/run/1')
  })

  it('bounds a chatty check instead of pasting its whole log', () => {
    const noisy = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')

    const body = judgeHealth([
      check('check-actions-enablement', 1, noisy),
      check('check-nightly-liveness', 0)
    ]).body

    expect(body).toContain('line 199')
    expect(body).not.toContain('line 100\n')
  })
})

describe('what to do with the issue', () => {
  it('opens one when something is wrong and none is open', () => {
    expect(decideAction({ ok: false, issueNumber: null })).toBe('create')
  })

  it('updates the issue it already owns instead of filing a second', () => {
    expect(decideAction({ ok: false, issueNumber: 12 })).toBe('update')
  })

  it('closes it once both checks are clean, and does nothing when there was none', () => {
    expect(decideAction({ ok: true, issueNumber: 12 })).toBe('close')
    expect(decideAction({ ok: true, issueNumber: null })).toBe('none')
  })

  it('finds its own issue by exact title, not by a title prefix', () => {
    const issues = JSON.stringify([
      { number: 3, title: `${ISSUE_TITLE} (cache)` },
      { number: 9, title: ISSUE_TITLE }
    ])

    expect(findOpenIssue(issues)).toMatchObject({ number: 9 })
    expect(findOpenIssue('[]')).toBe(null)
  })
})

describe('the lane that runs it', () => {
  it('exists, runs both checks through one script, and declares what it reads and writes', () => {
    const workflow = readWorkflow('.github/workflows/fork-ci-health.yml')

    expect(triggerKeys(workflow.on)).toEqual(
      expect.arrayContaining(['schedule', 'workflow_dispatch'])
    )
    expect(workflow.permissions).toMatchObject({ actions: 'read', issues: 'write' })
    expect(runScripts(workflow)).toContainEqual(
      expect.stringContaining('node local/ci-health-report.mjs')
    )
  })

  it('has a script on disk for every check it claims to run', () => {
    for (const entry of CHECKS) {
      expect(existsSync(join(REPO_ROOT, entry.script)), entry.script).toBe(true)
    }
  })
})
