import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_AUTO_LABEL,
  CHECKS,
  ISSUE_TITLE,
  MARKER,
  argsFor,
  closeComment,
  decideAction,
  decideLabel,
  disabledBySweep,
  findOpenIssue,
  issueLabels,
  issueLookupArgs,
  issueNumberFromCreateOutput,
  judgeDelegation,
  judgeHealth,
  labelAction,
  labelEnv,
  maySweep
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

describe('the delegation to the agent pipeline', () => {
  it('delegates an attention verdict and names the check that caused it', () => {
    const delegation = judgeDelegation([
      check('check-actions-enablement', 1),
      check('check-nightly-liveness', 0)
    ])

    expect(delegation.delegate).toBe(true)
    expect(delegation.reason).toContain('check-actions-enablement')
  })

  it('does not delegate a night where nothing reached a verdict', () => {
    const delegation = judgeDelegation([
      check('check-actions-enablement', 2),
      check('check-nightly-liveness', 2)
    ])

    expect(delegation.delegate).toBe(false)
    expect(delegation.reason).toContain('broken check is not a scoped defect')
  })

  it('delegates on one real red even when another check could not tell', () => {
    expect(
      judgeDelegation([check('check-actions-enablement', 2), check('check-nightly-liveness', 1)])
    ).toMatchObject({ delegate: true })
  })

  it('delegates nothing on a clean night', () => {
    expect(judgeDelegation(clean())).toMatchObject({
      delegate: false,
      reason: 'every check is clean'
    })
  })

  it('tells the reader in the issue body whether it was delegated', () => {
    expect(
      judgeHealth([check('check-actions-enablement', 1), check('check-nightly-liveness', 0)]).body
    ).toContain(`**Delegated:** \`${AGENT_AUTO_LABEL}\` is applied`)
    expect(judgeHealth(clean()).body).toContain('**Not delegated:**')
  })

  it('says an allowlisted class cannot reach the issue, so the red is unclassified', () => {
    const body = judgeHealth([
      check('check-actions-enablement', 0),
      check('check-nightly-liveness', 1)
    ]).body

    expect(body).toContain('local/check-unit-shard-verdict.mjs')
    expect(body).toContain('known-red classes stay out of the delegation')
  })

  it('reconciles the label with the verdict, and never strips it on close', () => {
    expect(labelAction({ delegate: true, hasLabel: false })).toBe('add')
    expect(labelAction({ delegate: true, hasLabel: true })).toBe('none')
    expect(labelAction({ delegate: false, hasLabel: true })).toBe('remove')
    expect(labelAction({ delegate: false, hasLabel: false })).toBe('none')
  })

  it('reads label names whether gh returns objects or strings', () => {
    expect(issueLabels({ labels: [{ name: AGENT_AUTO_LABEL }, { name: 'bug' }] })).toEqual([
      AGENT_AUTO_LABEL,
      'bug'
    ])
    expect(issueLabels({ labels: ['bug'] })).toEqual(['bug'])
    expect(issueLabels({})).toEqual([])
    expect(issueLabels(null)).toEqual([])
  })

  it('asks the lookup for labels, so the reconciliation has something to read', () => {
    const args = issueLookupArgs()

    expect(args[args.indexOf('--json') + 1].split(',')).toContain('labels')
  })

  // The old title claimed "never strips it on close" while only `labelAction` was tested. The close rule
  // lives in the orchestration, so it is extracted into `decideLabel` and pinned where it actually runs.
  it('never strips the label on close, because it is the audit record', () => {
    expect(decideLabel({ action: 'close', delegated: false, labels: [AGENT_AUTO_LABEL] })).toBe(
      'none'
    )
    expect(decideLabel({ action: 'close', delegated: true, labels: [AGENT_AUTO_LABEL] })).toBe(
      'none'
    )
  })

  it('adds on a red create or update, and removes once the red has cleared', () => {
    expect(decideLabel({ action: 'create', delegated: true, labels: [] })).toBe('add')
    expect(decideLabel({ action: 'update', delegated: true, labels: [] })).toBe('add')
    expect(decideLabel({ action: 'update', delegated: false, labels: [AGENT_AUTO_LABEL] })).toBe(
      'remove'
    )
    expect(decideLabel({ action: 'update', delegated: false, labels: [] })).toBe('none')
    expect(decideLabel({ action: 'update', delegated: true, labels: [AGENT_AUTO_LABEL] })).toBe(
      'none'
    )
  })

  // A `[bot]` actor is refused by the driver before it checks permission, so the workflow token must not
  // survive into the child environment under either name.
  it('builds a child env where the workflow token cannot win by precedence', () => {
    const env = labelEnv({ GH_TOKEN: 'bot', GITHUB_TOKEN: 'bot', PATH: '/bin' }, 'pat')

    expect(env.GH_TOKEN).toBe('pat')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env.PATH).toBe('/bin')
  })

  // The first branch dispatch created the issue and then failed, because `gh issue list --search`
  // reads a search index that had not caught up. The create output is the immediate answer.
  it('reads the new issue number from the create output, not from the lagging search index', () => {
    expect(issueNumberFromCreateOutput('https://github.com/nplez1/orca/issues/290\n')).toBe(290)
    expect(issueNumberFromCreateOutput('https://github.com/nplez1/orca/issues/290')).toBe(290)
    expect(issueNumberFromCreateOutput('  https://github.com/nplez1/orca/issues/7  ')).toBe(7)
  })

  it('answers null rather than a wrong number when the output has no URL', () => {
    expect(issueNumberFromCreateOutput('')).toBe(null)
    expect(issueNumberFromCreateOutput(null)).toBe(null)
    expect(issueNumberFromCreateOutput('Creating issue...')).toBe(null)
    expect(issueNumberFromCreateOutput('https://github.com/nplez1/orca/issues/not-a-number')).toBe(
      null
    )
  })
})

describe('the lane that runs it', () => {
  it('exists, runs both checks through one script, and declares what it reads and writes', () => {
    const workflow = readWorkflow('.github/workflows/fork-ci-health.yml')

    expect(triggerKeys(workflow.on)).toEqual(
      expect.arrayContaining(['schedule', 'workflow_dispatch'])
    )
    // `actions: write` is the sweep's: disabling a file and cancelling its run both need it.
    expect(workflow.permissions).toMatchObject({ actions: 'write', issues: 'write' })
    expect(runScripts(workflow)).toContainEqual(
      expect.stringContaining('node local/ci-health-report.mjs --fix')
    )
  })

  // Only the enablement check owns state; the other two read it, and a fix flag they ignore is a
  // permission nobody asked for.
  it('gives the fix to the enablement check alone', () => {
    for (const entry of CHECKS) {
      const expected = entry.name === 'check-actions-enablement' ? ['--fix'] : []
      expect(argsFor(entry, true), entry.name).toEqual(expected)
      expect(argsFor(entry, false), entry.name).toEqual([])
    }
  })

  it('has a script on disk for every check it claims to run', () => {
    for (const entry of CHECKS) {
      expect(existsSync(join(REPO_ROOT, entry.script)), entry.script).toBe(true)
    }
  })

  it('labels with a token that is not the workflow token, because a bot cannot delegate', () => {
    const workflow = readWorkflow('.github/workflows/fork-ci-health.yml')
    const steps = workflow.jobs.health.steps
    const report = steps.find((step) => String(step.run ?? '').includes('ci-health-report.mjs'))

    expect(report.env).toMatchObject({ GH_DELEGATE_TOKEN: '${{ secrets.AGENT_DELEGATE_TOKEN }}' })
    expect(report.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
  })
})

describe('the issue lookup', () => {
  it('quotes the title, which GitHub search needs to read as a phrase not a qualifier', () => {
    const args = issueLookupArgs()

    expect(args[args.indexOf('--search') + 1]).toBe(`"${ISSUE_TITLE}" in:title`)
  })

  it('lists only open issues, so a closed one is not silently updated', () => {
    const args = issueLookupArgs()

    expect(args[args.indexOf('--state') + 1]).toBe('open')
  })
})

describe('the sweep', () => {
  it('sweeps on the release line only', () => {
    expect(maySweep({ fix: true, dryRun: false, ref: 'refs/heads/main' })).toBe(true)
    // A dispatch runs the tree of the ref it was dispatched on, and that tree may predate a lane
    // joining REQUIRED — the sweep would then disable a lane the release line needs.
    expect(maySweep({ fix: true, dryRun: false, ref: 'refs/heads/nplez1/issue-349' })).toBe(false)
    expect(maySweep({ fix: false, dryRun: false, ref: 'refs/heads/main' })).toBe(false)
    expect(maySweep({ fix: true, dryRun: true, ref: 'refs/heads/main' })).toBe(false)
    // No ref at all is a person at a terminal, not a lane.
    expect(maySweep({ fix: true, dryRun: false, ref: undefined })).toBe(true)
  })

  it('names what it turned off in the close comment, so a healed night still says so', () => {
    const output = [
      'check-actions: 81 workflows on nplez1/orca, 18 active',
      "  DRIFT    active but not on the fork's live list: .github/workflows/x.yml — X",
      "  disabled .github/workflows/x.yml (active but not on the fork's live list)",
      '  OK'
    ].join('\n')
    const checks = [
      check('check-actions-enablement', 0, output),
      check('check-nightly-liveness', 0)
    ]

    expect(disabledBySweep(checks)).toEqual(['.github/workflows/x.yml'])
    expect(closeComment(checks)).toContain('- `.github/workflows/x.yml`')
  })

  it('closes with the plain line when nothing was disabled', () => {
    expect(closeComment(clean())).toBe('All fork health checks are clean again.')
  })
})
