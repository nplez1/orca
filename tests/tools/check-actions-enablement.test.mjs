import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_RUNNER_LABELS,
  ALLOWED_INERT,
  EXPECTED_TRIGGERS,
  REQUIRED,
  judgeEnablement,
  readFacts,
  residualProblems,
  runnerLabelsOf,
  triggersOf
} from '../../local/check-actions-enablement.mjs'

const active = (path, id = 1) => ({ id, path, state: 'active', name: path.split('/').pop() })
const disabled = (path, id = 2) => ({ id, path, state: 'disabled_manually', name: path })
const factsFor = (path, triggers, extra = {}) => ({
  [path]: { triggers, runnerLabels: [], ...extra }
})

const judge = (workflows, facts, options) => judgeEnablement({ workflows, facts }, options)

describe('the pinned trigger table', () => {
  it('pins exactly the enabled set, with no path in one list and not the other', () => {
    expect([...REQUIRED, ...ALLOWED_INERT].sort()).toEqual(Object.keys(EXPECTED_TRIGGERS).sort())
  })

  it('matches the files in this checkout, so a sync fails the PR rather than the next morning', () => {
    const facts = readFacts(Object.keys(EXPECTED_TRIGGERS))

    for (const [path, pinned] of Object.entries(EXPECTED_TRIGGERS)) {
      expect(facts[path].triggers.sort(), path).toEqual([...pinned].sort())
    }
  })

  it('reads the three YAML shapes GitHub accepts, including the boolean reading of `on:`', () => {
    expect(triggersOf('on: push\n')).toEqual(['push'])
    expect(triggersOf('on: [push, pull_request]\n')).toEqual(['push', 'pull_request'])
    expect(triggersOf('on:\n  push:\n    branches: [main]\n')).toEqual(['push'])
  })
})

describe('a lane that grew a trigger', () => {
  it('reports the pin it broke and becomes a disable target', () => {
    const path = '.github/workflows/fork-pr-gates.yml'
    const verdict = judge([active(path)], factsFor(path, ['pull_request', 'push']))

    expect(verdict.ok).toBe(false)
    expect(verdict.triggerDrift).toEqual([
      { path, expected: EXPECTED_TRIGGERS[path], all: ['pull_request', 'push'] }
    ])
    expect(verdict.disableTargets.map((target) => target.path)).toEqual([path])
  })

  it('is clean when the triggers match regardless of the order they are written in', () => {
    const path = '.github/workflows/mobile.yml'
    const verdict = judge([active(path)], factsFor(path, ['push', 'pull_request']), {
      required: [path],
      allowedInert: [],
      expected: { [path]: ['pull_request', 'push'] }
    })

    expect(verdict.ok).toBe(true)
  })

  it('treats an enabled file with no pin as a problem, not as permission', () => {
    const path = '.github/workflows/unpinned.yml'
    const verdict = judge([active(path)], factsFor(path, ['pull_request']), {
      required: [path],
      allowedInert: []
    })

    expect(verdict.unpinned).toEqual([{ path, all: ['pull_request'] }])
    expect(verdict.disableTargets.map((target) => target.why)).toEqual([
      'active with no pinned triggers'
    ])
  })
})

describe('triggers and runners that must never reach an active file', () => {
  it('rejects pull_request_target even when the rest of the shape is pinned', () => {
    const path = '.github/workflows/ci-closed-pr-caches.yml'
    const verdict = judge([active(path)], factsFor(path, ['pull_request_target']), {
      required: [path],
      allowedInert: []
    })

    expect(verdict.pullRequestTarget).toEqual([{ path }])
    expect(verdict.ok).toBe(false)
  })

  it('rejects a blacksmith label on a file that is not recorded as accepting one', () => {
    const path = '.github/workflows/unit-tests.yml'
    const verdict = judge(
      [active(path)],
      { [path]: { triggers: ['workflow_call'], runnerLabels: ['blacksmith-4vcpu-ubuntu-2404'] } },
      { required: [path], allowedInert: [], expected: { [path]: ['workflow_call'] } }
    )

    expect(verdict.unapprovedRunners).toEqual([{ path, labels: ['blacksmith-4vcpu-ubuntu-2404'] }])
  })

  it('accepts the two recorded exceptions', () => {
    const paths = Object.keys(ACCEPTED_RUNNER_LABELS)
    const workflows = paths.map((path) => active(path))
    const facts = Object.fromEntries(
      paths.map((path) => [
        path,
        { triggers: EXPECTED_TRIGGERS[path], runnerLabels: ['blacksmith-4vcpu-ubuntu-2404'] }
      ])
    )
    const verdict = judge(workflows, facts, {
      required: paths,
      allowedInert: [],
      expected: Object.fromEntries(paths.map((path) => [path, EXPECTED_TRIGGERS[path]]))
    })

    expect(verdict.unapprovedRunners).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('finds a label inside a runs-on expression, not only a literal one', () => {
    const text = `on: pull_request
jobs:
  test:
    runs-on: \${{ inputs.fast && 'blacksmith-8vcpu-ubuntu-2404' || 'ubuntu-latest' }}
`

    expect(runnerLabelsOf(text)).toEqual(['blacksmith-8vcpu-ubuntu-2404'])
  })
})

describe('the rest of the verdict', () => {
  it('reports an active file that is on neither list', () => {
    const verdict = judge([active('.github/workflows/mystery.yml')], factsFor('x', ['push']), {
      required: [],
      allowedInert: [],
      expected: {}
    })

    expect(verdict.drift.map((entry) => entry.path)).toEqual(['.github/workflows/mystery.yml'])
    expect(verdict.ok).toBe(false)
  })

  it('reports a required lane that is off, and a pinned file that is gone', () => {
    const off = '.github/workflows/fork-main-tests.yml'
    const gone = '.github/workflows/fork-release.yml'
    const verdict = judge(
      [disabled(off)],
      {},
      {
        required: [off],
        allowedInert: [],
        expected: { [off]: ['schedule', 'workflow_dispatch'], [gone]: ['workflow_dispatch'] }
      }
    )

    expect(verdict.missing).toEqual([{ path: off, state: 'disabled_manually' }])
    expect(verdict.stale).toEqual([
      { path: gone, reason: 'no workflow file by that path on the repository' }
    ])
  })

  it('does not read an unreadable file as inert', () => {
    const path = '.github/workflows/fork-release.yml'
    const verdict = judge(
      [active(path)],
      { [path]: { error: 'not in this checkout' } },
      {
        required: [path],
        allowedInert: []
      }
    )

    expect(verdict.unreadable).toEqual([{ path, reason: 'not in this checkout' }])
    expect(verdict.ok).toBe(false)
  })

  it('reports one problem per file, not one per check that it fails', () => {
    const path = '.github/workflows/mystery.yml'
    const verdict = judge([active(path)], factsFor(path, ['pull_request_target']), {
      required: [],
      allowedInert: [],
      expected: {}
    })

    expect(verdict.drift).toHaveLength(1)
    expect(verdict.pullRequestTarget).toEqual([])
    expect(verdict.unpinned).toEqual([])
  })
})

describe('what --fix resolves and what it does not', () => {
  it('counts an unfixable finding as residual even after a clean --fix run', () => {
    const path = '.github/workflows/ci-closed-pr-caches.yml'
    const verdict = judge([active(path)], factsFor(path, ['pull_request_target']), {
      required: [path],
      allowedInert: [],
      expected: { [path]: ['pull_request_target'] }
    })

    expect(residualProblems({ verdict, fix: true, disabled: [], failed: [] })).toBe(1)
  })

  it('stops counting a disable target once it was disabled', () => {
    const path = '.github/workflows/mystery.yml'
    const verdict = judge([active(path)], factsFor(path, ['push']), {
      required: [],
      allowedInert: [],
      expected: {}
    })

    expect(residualProblems({ verdict, fix: true, disabled: [path], failed: [] })).toBe(0)
    expect(residualProblems({ verdict, fix: false, disabled: [], failed: [] })).toBe(1)
  })
})
