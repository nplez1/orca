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

  it('matches the files in this checkout, so drift is named the same day, not at the next release', () => {
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
  it('reports a required lane but leaves it enabled, so the sweep cannot disarm the watchdog', () => {
    const path = '.github/workflows/fork-ci-health.yml'
    const verdict = judge([active(path)], factsFor(path, ['schedule', 'push']), {
      required: [path],
      allowedInert: [],
      expected: { [path]: ['schedule', 'workflow_dispatch'] }
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.triggerDrift).toEqual([
      { path, expected: ['schedule', 'workflow_dispatch'], all: ['schedule', 'push'] }
    ])
    expect(verdict.requiredTriggerDrift.map((entry) => entry.path)).toEqual([path])
    expect(verdict.disableTargets).toEqual([])
    // And it stays outstanding under --fix, so the sweep cannot report itself clean.
    expect(residualProblems({ verdict, fix: true, disabled: [], failed: [] })).toBe(1)
  })

  it('disables a lane that is allowed to be inert, because disabled is fine for one', () => {
    const path = '.github/workflows/layout-owner-e2e.yml'
    const verdict = judge([active(path)], factsFor(path, ['workflow_dispatch', 'pull_request']), {
      required: [],
      allowedInert: [path],
      expected: { [path]: ['workflow_dispatch'] }
    })

    expect(verdict.requiredTriggerDrift).toEqual([])
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
      allowedInert: [],
      expected: { [path]: ['pull_request_target'] }
    })

    expect(verdict.forbiddenTriggers).toEqual([{ path, triggers: ['pull_request_target'] }])
    expect(verdict.ok).toBe(false)
  })

  it('rejects workflow_run too, which also runs with a write token on fork events', () => {
    const path = '.github/workflows/some-followup.yml'
    const verdict = judge([active(path)], factsFor(path, ['workflow_run']), {
      required: [path],
      allowedInert: [],
      expected: { [path]: ['workflow_run'] }
    })

    expect(verdict.forbiddenTriggers).toEqual([{ path, triggers: ['workflow_run'] }])
  })

  it('rejects a blacksmith label on a file that is not recorded as accepting one', () => {
    const path = '.github/workflows/unit-module-cache.yml'
    const verdict = judge(
      [active(path)],
      { [path]: { triggers: ['workflow_call'], runnerLabels: ['blacksmith-4vcpu-ubuntu-2404'] } },
      { required: [path], allowedInert: [], expected: { [path]: ['workflow_call'] } }
    )

    expect(verdict.unapprovedRunners).toEqual([
      { path, labels: ['blacksmith-4vcpu-ubuntu-2404'], reachedFrom: path }
    ])
  })

  it('accepts the recorded exceptions, and only for the labels they record', () => {
    // The table also carries callees that are not themselves active (`e2e.yml`), so this test drives
    // only the ones a repository state can hold active.
    const paths = Object.keys(ACCEPTED_RUNNER_LABELS).filter((path) =>
      Object.hasOwn(EXPECTED_TRIGGERS, path)
    )
    const facts = Object.fromEntries(
      paths.map((path) => [
        path,
        { triggers: EXPECTED_TRIGGERS[path], runnerLabels: ACCEPTED_RUNNER_LABELS[path].labels }
      ])
    )
    const verdict = judge(
      paths.map((path) => active(path)),
      facts,
      {
        required: paths,
        allowedInert: [],
        expected: Object.fromEntries(paths.map((path) => [path, EXPECTED_TRIGGERS[path]]))
      }
    )

    expect(verdict.unapprovedRunners).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('fails a new label in an excepted file, so the exception cannot cover a job added later', () => {
    const path = '.github/workflows/node-server-tests.yml'
    const accepted = ACCEPTED_RUNNER_LABELS[path].labels
    const verdict = judge(
      [active(path)],
      {
        [path]: {
          triggers: EXPECTED_TRIGGERS[path],
          runnerLabels: [...accepted, 'blacksmith-16vcpu-ubuntu-2404']
        }
      },
      { required: [path], allowedInert: [], expected: { [path]: EXPECTED_TRIGGERS[path] } }
    )

    expect(verdict.unapprovedRunners).toEqual([
      { path, labels: ['blacksmith-16vcpu-ubuntu-2404'], reachedFrom: path }
    ])
  })

  it('reports a label a callee would request, naming the active lane that reaches it', () => {
    const caller = '.github/workflows/fork-release.yml'
    const callee = '.github/workflows/some-callee.yml'
    const verdict = judge(
      [active(caller)],
      {
        [caller]: { triggers: EXPECTED_TRIGGERS[caller], runnerLabels: [], callees: [callee] },
        [callee]: { triggers: ['workflow_call'], runnerLabels: ['blacksmith-8vcpu-ubuntu-2404'] }
      },
      { required: [caller], allowedInert: [], expected: { [caller]: EXPECTED_TRIGGERS[caller] } }
    )

    expect(verdict.unapprovedRunners).toEqual([
      { path: callee, labels: ['blacksmith-8vcpu-ubuntu-2404'], reachedFrom: caller }
    ])
  })

  it('ignores a label that is only compared or echoed, which is how unit-tests.yml mentions one', () => {
    const text = `on: workflow_call
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "== blacksmith-8vcpu-ubuntu-2404"
`

    expect(runnerLabelsOf(text)).toEqual([])
  })

  it('finds a label in an input default, which is the one unit-tests.yml really asks for', () => {
    const text = `on:
  workflow_call:
    inputs:
      runner:
        default: blacksmith-4vcpu-ubuntu-2404
jobs:
  test:
    runs-on: \${{ inputs.runner }}
`

    expect(runnerLabelsOf(text)).toEqual(['blacksmith-4vcpu-ubuntu-2404'])
  })

  it('finds a label in a matrix list, which selects runners without the key `runs-on`', () => {
    const text = `on: workflow_call
jobs:
  warm:
    strategy:
      matrix:
        runner: [blacksmith-4vcpu-ubuntu-2404, ubuntu-24.04]
    runs-on: \${{ matrix.runner }}
`

    expect(runnerLabelsOf(text)).toEqual(['blacksmith-4vcpu-ubuntu-2404'])
  })

  it('finds a label a caller passes through with:, which is how the 2026-10-28 wedge happened', () => {
    const text = `on: workflow_call
jobs:
  unit:
    uses: ./.github/workflows/unit-tests.yml
    with:
      runner: blacksmith-8vcpu-ubuntu-2404
`

    expect(runnerLabelsOf(text)).toEqual(['blacksmith-8vcpu-ubuntu-2404'])
  })

  it('follows a call chain more than one hop, so a label two calls down is still judged', () => {
    const first = '.github/workflows/fork-main-tests.yml'
    const second = '.github/workflows/some-hub.yml'
    const third = '.github/workflows/some-callee.yml'
    const verdict = judge(
      [active(first)],
      {
        [first]: { triggers: EXPECTED_TRIGGERS[first], runnerLabels: [], callees: [second] },
        [second]: { triggers: ['workflow_call'], runnerLabels: [], callees: [third] },
        [third]: { triggers: ['workflow_call'], runnerLabels: ['blacksmith-8vcpu-ubuntu-2404'] }
      },
      { required: [first], allowedInert: [], expected: { [first]: EXPECTED_TRIGGERS[first] } }
    )

    expect(verdict.unapprovedRunners).toEqual([
      { path: third, labels: ['blacksmith-8vcpu-ubuntu-2404'], reachedFrom: first }
    ])
  })

  it('reports a callee it cannot read, rather than treating it as label-free', () => {
    const caller = '.github/workflows/fork-release.yml'
    const callee = '.github/workflows/some-gone.yml'
    const verdict = judge(
      [active(caller)],
      {
        [caller]: { triggers: EXPECTED_TRIGGERS[caller], runnerLabels: [], callees: [callee] },
        [callee]: { error: 'not in this checkout' }
      },
      { required: [caller], allowedInert: [], expected: { [caller]: EXPECTED_TRIGGERS[caller] } }
    )

    expect(verdict.unreadable).toEqual([
      { path: callee, reason: `reached from ${caller}: not in this checkout` }
    ])
    expect(verdict.ok).toBe(false)
  })

  it('finds a label inside a runs-on expression, not only a literal one', () => {
    const text = `on: pull_request
jobs:
  test:
    runs-on: \${{ inputs.fast && 'blacksmith-8vcpu-ubuntu-2404' || 'ubuntu-latest' }}
`

    expect(runnerLabelsOf(text)).toEqual(['blacksmith-8vcpu-ubuntu-2404'])
  })

  it('covers the tree in both directions, so neither the table nor the scan can drift', () => {
    const facts = readFacts(Object.keys(EXPECTED_TRIGGERS))

    for (const [path, entry] of Object.entries(facts)) {
      const accepted = ACCEPTED_RUNNER_LABELS[path]?.labels ?? []
      for (const label of entry.runnerLabels ?? []) {
        expect(accepted, `${path} names ${label}`).toContain(label)
      }
    }
    // The other way: a table entry whose file yields no labels is dead weight, which is exactly how a
    // key-restricted scan went blind to matrix lists without a test noticing.
    for (const [path, entry] of Object.entries(ACCEPTED_RUNNER_LABELS)) {
      const found = facts[path]?.runnerLabels ?? []
      for (const label of entry.labels) {
        expect(found, `${path} should name ${label}`).toContain(label)
      }
    }
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
    expect(verdict.forbiddenTriggers).toEqual([])
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
