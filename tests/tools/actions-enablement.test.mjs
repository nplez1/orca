import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_INERT,
  EXPECTED_TRIGGERS,
  applyFixes,
  REQUIRED,
  cancellableRuns,
  exitCodeFor,
  judgeEnablement,
  planEnables,
  readFacts,
  residualProblems,
  triggersOf,
  workflowListArgs,
  workflowsFromPages
} from '../../local/check-actions-enablement.mjs'

const REPO_ROOT = new URL('../../', import.meta.url).pathname
const active = (path, name = path) => ({ id: 1, path, state: 'active', name })
const disabled = (path) => ({ id: 2, path, state: 'disabled_manually', name: path })

/** A repository where every allowed entry is active with its pinned triggers, which is the healthy shape. */
const healthy = () => ({
  workflows: [
    ...REQUIRED.map((path) => active(path)),
    ...ALLOWED_INERT.map((path) => active(path))
  ],
  facts: Object.fromEntries(
    [...REQUIRED, ...ALLOWED_INERT].map((path) => [
      path,
      { triggers: EXPECTED_TRIGGERS[path], runnerLabels: [], callees: [] }
    ])
  )
})

describe('workflow triggers', () => {
  it('reads the map, string and list forms of on:', () => {
    expect(
      triggersOf('on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: "0 1 * * *"\n')
    ).toEqual(['push', 'schedule'])
    expect(triggersOf('on: workflow_dispatch\n')).toEqual(['workflow_dispatch'])
    expect(triggersOf('on: [workflow_dispatch, workflow_call]\n')).toEqual([
      'workflow_dispatch',
      'workflow_call'
    ])
  })

  it('reads a file with no on: block as firing on nothing', () => {
    expect(triggersOf('name: x\njobs: {}\n')).toEqual([])
  })
})

describe('judging enablement', () => {
  it('passes the healthy shape', () => {
    expect(judgeEnablement(healthy())).toMatchObject({ ok: true, drift: [], missing: [] })
  })

  it('reports an active workflow nobody asked for', () => {
    const state = healthy()
    state.workflows.push(active('.github/workflows/wsl-orcad-e2e.yml'))

    expect(judgeEnablement(state).drift.map((w) => w.path)).toEqual([
      '.github/workflows/wsl-orcad-e2e.yml'
    ])
  })

  it('reports a required workflow that was disabled or is absent', () => {
    const state = healthy()
    state.workflows = state.workflows.map((w) =>
      w.path === '.github/workflows/fork-main-tests.yml' ? disabled(w.path) : w
    )

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual([
      { path: '.github/workflows/fork-main-tests.yml', state: 'disabled_manually' }
    ])
    expect(judgeEnablement({ workflows: [] }).missing.map((m) => m.state)).toEqual(
      REQUIRED.map(() => 'absent')
    )
  })

  it('fails an allowed-inert entry that gained a trigger no human starts', () => {
    const state = healthy()
    state.facts['.github/workflows/layout-owner-e2e.yml'] = {
      triggers: ['workflow_dispatch', 'pull_request'],
      runnerLabels: [],
      callees: []
    }

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.triggerDrift).toEqual([
      {
        path: '.github/workflows/layout-owner-e2e.yml',
        expected: ['workflow_dispatch'],
        all: ['workflow_dispatch', 'pull_request']
      }
    ])
    // And --fix is allowed to turn it off: "disabled is also fine" is the entry's own contract.
    expect(verdict.disableTargets.map((target) => target.path)).toContain(
      '.github/workflows/layout-owner-e2e.yml'
    )
  })

  it('fails an allowed-inert entry with no trigger facts at all, rather than assuming inert', () => {
    const state = healthy()
    delete state.facts['.github/workflows/zcode-account-contract.yml']

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.unreadable).toEqual([
      {
        path: '.github/workflows/zcode-account-contract.yml',
        reason: 'not read, so its triggers are unproven'
      }
    ])
  })

  it('accepts a called workflow, which only a caller can start', () => {
    const state = healthy()
    state.facts['.github/workflows/qualified-orcad-template.yml'] = {
      triggers: ['workflow_call'],
      runnerLabels: [],
      callees: []
    }

    expect(judgeEnablement(state).ok).toBe(true)
  })

  it('fails an allowed-inert entry whose triggers cannot be read, rather than assuming inert', () => {
    const state = healthy()
    state.facts['.github/workflows/zcode-account-contract.yml'] = {
      error: 'not in this checkout'
    }

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.unreadable).toEqual([
      { path: '.github/workflows/zcode-account-contract.yml', reason: 'not in this checkout' }
    ])
  })

  it('reports an allowed-inert entry no workflow file backs any more', () => {
    const state = healthy()
    state.workflows = state.workflows.filter(
      (w) => w.path !== '.github/workflows/dev-channel-win-publish.yml'
    )

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.stale.map((s) => s.path)).toEqual([
      '.github/workflows/dev-channel-win-publish.yml'
    ])
  })
})

describe('the workflow list', () => {
  it('merges every page, so the 101st file is not invisible', () => {
    const pages = [
      { total_count: 3, workflows: [active('a.yml'), active('b.yml')] },
      { total_count: 3, workflows: [active('c.yml')] }
    ]

    expect(workflowsFromPages(pages).map((w) => w.path)).toEqual(['a.yml', 'b.yml', 'c.yml'])
  })

  it('treats a page with no workflows key as empty', () => {
    expect(workflowsFromPages([{}, { workflows: null }])).toEqual([])
  })

  it('asks for every page, so the list cannot be silently truncated at 100', () => {
    expect(workflowListArgs()).toEqual(expect.arrayContaining(['--paginate', '--slurp']))
  })
})

describe('what --fix is allowed to stop', () => {
  it('cancels the runs that would still execute, and leaves finished ones alone', () => {
    const runs = [
      { databaseId: 1, status: 'in_progress' },
      { databaseId: 2, status: 'queued' },
      { databaseId: 3, status: 'completed' },
      { databaseId: 4, status: 'waiting' }
    ]

    expect(cancellableRuns(runs)).toEqual([1, 2, 4])
    expect(cancellableRuns(undefined)).toEqual([])
  })

  it('counts a disabled target as resolved and a failed one as outstanding', () => {
    const state = healthy()
    state.workflows.push(active('.github/workflows/wsl-orcad-e2e.yml', 'WSL'))
    const verdict = judgeEnablement(state)
    const path = '.github/workflows/wsl-orcad-e2e.yml'

    expect(residualProblems({ verdict })).toBe(1)
    expect(residualProblems({ verdict, fix: true, disabled: [path] })).toBe(0)
    expect(residualProblems({ verdict, fix: true, disabled: [] })).toBe(1)
  })

  it('still counts a required workflow that was disabled as outstanding under --fix', () => {
    const state = healthy()
    state.workflows = state.workflows.map((w) =>
      w.path === '.github/workflows/fork-main-tests.yml' ? disabled(w.path) : w
    )

    expect(residualProblems({ verdict: judgeEnablement(state), fix: true, disabled: [] })).toBe(1)
  })
})

// The lists above are claims about this tree; these are the checks that keep them true.
describe('the live list against this checkout', () => {
  it('names a file for every entry it claims, and every file is there', () => {
    for (const path of [...REQUIRED, ...ALLOWED_INERT]) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true)
    }
  })

  it('every allowed-inert workflow is inert in this tree', () => {
    const facts = readFacts(ALLOWED_INERT, REPO_ROOT)
    const inert = new Set(['workflow_dispatch', 'workflow_call'])

    // Only the requested paths: readFacts also returns the callees it followed, and a callee's own
    // triggers say nothing about whether this entry is inert.
    for (const path of ALLOWED_INERT) {
      const entry = facts[path]
      expect(Array.isArray(entry.triggers), `${path}: ${entry.error}`).toBe(true)
      for (const trigger of entry.triggers) {
        expect(inert.has(trigger), `${path} fires on ${trigger}`).toBe(true)
      }
    }
  })
})

describe('applying --fix', () => {
  const driftState = () => {
    const state = healthy()
    state.workflows.push({ ...active('.github/workflows/wsl-orcad-e2e.yml', 'WSL'), id: 7 })
    return judgeEnablement(state)
  }

  const failingGh =
    (calls, { failCancel = false } = {}) =>
    (args) => {
      calls.push(args)
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          { databaseId: 41, status: 'in_progress' },
          { databaseId: 42, status: 'completed' }
        ])
      }
      if (args[0] === 'run' && args[1] === 'cancel' && (failCancel || args[2] === '42')) {
        throw new Error('boom')
      }
      return ''
    }

  it('disables by workflow id and reads running runs by that id, not by path', () => {
    const calls = []

    const result = applyFixes(driftState(), true, failingGh(calls), () => {})

    expect(result).toEqual({
      enabled: [],
      disabled: ['.github/workflows/wsl-orcad-e2e.yml'],
      failed: []
    })
    expect(calls[0]).toEqual(['workflow', 'disable', '7', '--repo', 'nplez1/orca'])
    expect(calls[1]).toEqual(expect.arrayContaining(['run', 'list', '--workflow', '7']))
    expect(calls[1]).not.toContain('.github/workflows/wsl-orcad-e2e.yml')
    // The completed run is not cancelled; the in-progress one is.
    expect(calls.slice(2).map((args) => args[2])).toEqual(['41'])
  })

  it('does nothing without --fix', () => {
    const calls = []

    expect(applyFixes(driftState(), false, failingGh(calls), () => {})).toEqual({
      enabled: [],
      disabled: [],
      failed: []
    })
    expect(calls).toEqual([])
  })

  it('reports a disable that failed, and leaves it outstanding', () => {
    const result = applyFixes(
      driftState(),
      true,
      () => {
        throw new Error('HTTP 403')
      },
      () => {}
    )

    expect(result).toEqual({
      enabled: [],
      disabled: [],
      failed: ['.github/workflows/wsl-orcad-e2e.yml']
    })
  })

  it('keeps a disabled workflow disabled and outstanding when the cancel step fails', () => {
    const result = applyFixes(driftState(), true, failingGh([], { failCancel: true }), () => {})

    // The workflow is off either way, so this is not "could not disable" — but a run may still be
    // going, which has to leave the run non-zero rather than read as swept.
    expect(result.disabled).toEqual(['.github/workflows/wsl-orcad-e2e.yml'])
    expect(result.failed).toEqual(['.github/workflows/wsl-orcad-e2e.yml'])
    expect(
      residualProblems({
        verdict: driftState(),
        fix: true,
        disabled: result.disabled,
        failed: result.failed
      })
    ).toBe(1)
  })
})

// The mirror of the disable sweep. A `REQUIRED` lane that is present but off is repository state, so no
// branch can carry the fix: issue #447 was three of them, delegated to an agent whose PR could not
// contain the answer. These cases pin both halves — that it is restored, and that it is restored
// *visibly*, since `disabled_manually` only ever comes from a deliberate act.
describe('restoring a required lane the sweep can restore', () => {
  const off = '.github/workflows/performance-contracts.yml'

  const offState = (mutate) => {
    const state = healthy()
    state.workflows = state.workflows.map((workflow) =>
      workflow.path === off ? { ...workflow, id: 11, state: 'disabled_manually' } : workflow
    )
    mutate?.(state)
    return state
  }

  const verdictFor = (state) => ({ ...judgeEnablement(state), ...planEnables(state) })

  it('targets a required lane that is off, and enables it by workflow id', () => {
    const verdict = verdictFor(offState())

    expect(verdict.enableTargets).toEqual([{ path: off, id: 11, state: 'disabled_manually' }])

    const calls = []
    const result = applyFixes(
      verdict,
      true,
      (args) => {
        calls.push(args)
        return ''
      },
      () => {}
    )

    expect(calls).toEqual([['workflow', 'enable', '11', '--repo', 'nplez1/orca']])
    expect(result.enabled).toEqual([off])
  })

  it('stays outstanding and exits 3 on the day it restored one, rather than reading clean', () => {
    const verdict = verdictFor(offState())
    const residual = residualProblems({ verdict, fix: true, disabled: [], failed: [] })

    expect(residual).toBe(1)
    expect(exitCodeFor(verdict, residual)).toBe(3)
  })

  it('never targets a lane whose file is gone, because restoring that is a diff', () => {
    const state = healthy()
    state.workflows = state.workflows.filter((workflow) => workflow.path !== off)
    const verdict = verdictFor(state)

    expect(verdict.enableTargets).toEqual([])
    expect(verdict.missing).toEqual([{ path: off, state: 'absent' }])
    expect(exitCodeFor(verdict, residualProblems({ verdict }))).toBe(1)
  })

  // The active-lane checks only loop over active files, so an off lane has never been judged. Restoring
  // one whose shape is itself a hazard would bring the hazard back with it — a 24 h queue, a write
  // token, or the inherited cron of 2026-11-06.
  it.each([
    ['an inherited cron', { triggers: [...EXPECTED_TRIGGERS[off], 'schedule'] }],
    ['a runner nothing provisions', { runnerLabels: ['blacksmith-8vcpu-ubuntu-2404'] }],
    ['a write-token trigger', { triggers: ['pull_request_target', ...EXPECTED_TRIGGERS[off]] }],
    ['a file that cannot be read', { error: 'not in this checkout' }]
  ])('holds a lane back for %s', (_label, hazard) => {
    const state = offState((unhealthy) => {
      // `readFacts` writes `{ error }` alone for a file it could not read, so the fixture has to match
      // that shape rather than keep the triggers it could not have read.
      unhealthy.facts[off] = hazard.error ? hazard : { ...unhealthy.facts[off], ...hazard }
    })
    const verdict = planEnables(state)

    expect(verdict.enableTargets).toEqual([])
    expect(verdict.blockedEnables.map((entry) => entry.path)).toEqual([off])
  })

  // The 2026-10-26 incident shape: a called workflow runs whatever its own state is, so the caller is
  // the decision. `fork-release.yml` is an *active* required lane and reaches the callee first, so the
  // hazard is attributed to it — which is exactly why the hold cannot be read off `reachedFrom`, and
  // why this fixture has an active lane sharing the callee.
  it('holds a lane back for a hazard in a workflow it calls, even when an active lane calls it too', () => {
    const callee = '.github/workflows/unit-tests.yml'
    const shared = '.github/workflows/fork-release.yml'
    const state = offState((unhealthy) => {
      unhealthy.facts[shared] = { ...unhealthy.facts[shared], callees: [callee] }
      unhealthy.facts[off] = { ...unhealthy.facts[off], callees: [callee] }
      unhealthy.facts[callee] = {
        triggers: ['workflow_call'],
        runnerLabels: ['self-hosted'],
        callees: []
      }
    })
    const verdict = planEnables(state)

    expect(verdict.enableTargets).toEqual([])
    expect(verdict.blockedEnables.map((entry) => entry.path)).toEqual([off])
  })

  it('reports an enable the token refused, and leaves it outstanding', () => {
    const result = applyFixes(
      verdictFor(offState()),
      true,
      () => {
        throw new Error('HTTP 403')
      },
      () => {}
    )

    expect(result.enabled).toEqual([])
    expect(result.failed).toEqual([off])
  })

  it('enables nothing without --fix', () => {
    const calls = []

    applyFixes(
      verdictFor(offState()),
      false,
      (args) => {
        calls.push(args)
        return ''
      },
      () => {}
    )

    expect(calls).toEqual([])
  })
})
