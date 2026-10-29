import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_INERT,
  INERT_TRIGGERS,
  REQUIRED,
  judgeEnablement,
  readTriggers,
  triggersOf,
  workflowsFromPages
} from '../../local/check-actions-enablement.mjs'

const REPO_ROOT = new URL('../../', import.meta.url).pathname
const active = (path, name = path) => ({ id: 1, path, state: 'active', name })
const disabled = (path) => ({ id: 2, path, state: 'disabled_manually', name: path })

/** A repository where every allowed entry is active and inert, which is the healthy shape. */
const healthy = () => ({
  workflows: [
    ...REQUIRED.map((path) => active(path)),
    ...ALLOWED_INERT.map((path) => active(path))
  ],
  triggers: Object.fromEntries(ALLOWED_INERT.map((path) => [path, ['workflow_dispatch']]))
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
    state.triggers['.github/workflows/layout-owner-e2e.yml'] = ['workflow_dispatch', 'pull_request']

    const verdict = judgeEnablement(state)

    expect(verdict.ok).toBe(false)
    expect(verdict.overTriggered).toEqual([
      {
        path: '.github/workflows/layout-owner-e2e.yml',
        triggers: ['pull_request'],
        all: ['workflow_dispatch', 'pull_request']
      }
    ])
  })

  it('accepts a called workflow, which only a caller can start', () => {
    const state = healthy()
    state.triggers['.github/workflows/qualified-orcad-template.yml'] = ['workflow_call']

    expect(judgeEnablement(state).ok).toBe(true)
  })

  it('fails an allowed-inert entry whose triggers cannot be read, rather than assuming inert', () => {
    const state = healthy()
    state.triggers['.github/workflows/zcode-account-contract.yml'] = {
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
})

// The lists above are claims about this tree; these are the checks that keep them true.
describe('the live list against this checkout', () => {
  it('names a file for every entry it claims, and every file is there', () => {
    for (const path of [...REQUIRED, ...ALLOWED_INERT]) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true)
    }
  })

  it('every allowed-inert workflow is inert in this tree', () => {
    const triggers = readTriggers(ALLOWED_INERT, REPO_ROOT)

    for (const [path, facts] of Object.entries(triggers)) {
      expect(Array.isArray(facts), `${path}: ${facts.error}`).toBe(true)
      for (const trigger of facts) {
        expect(INERT_TRIGGERS.has(trigger), `${path} fires on ${trigger}`).toBe(true)
      }
    }
  })
})
