import { describe, expect, it } from 'vitest'
import {
  candidateRef,
  filterPatternRegex,
  isCandidateBranch,
  isForkUrl,
  newRunId,
  partitionForCleanup,
  pushFires,
  refusalsFor,
  runIdFrom,
  workflowsFiredBy
} from '../../local/sync/linux-lane.mjs'

const LANE = '.github/workflows/fork-main-tests.yml'
const lane = 'on:\n  schedule:\n    - cron: "53 4 * * *"\n  workflow_dispatch:\njobs: {}\n'
const branch = candidateRef('0123456789abcdef0123')

describe('the candidate push starts nothing but the dispatch', () => {
  it('names the ref after the revision, so a push only ever creates one', () => {
    expect(branch).toBe('sync-candidate/0123456789ab')
  })

  it('reads GitHub branch filters the way GitHub does', () => {
    expect(pushFires({ branches: ['main'] }, branch)).toBe(false)
    expect(pushFires({ branches: ['main'] }, 'main')).toBe(true)
    expect(pushFires({ branches: ['*'] }, branch)).toBe(false)
    expect(pushFires({ branches: ['**'] }, branch)).toBe(true)
    expect(pushFires({ branches: ['sync-*/**', '!sync-candidate/**'] }, branch)).toBe(false)
    expect(pushFires({ 'branches-ignore': ['main'] }, branch)).toBe(true)
    expect(pushFires({ 'branches-ignore': ['sync-candidate/**'] }, branch)).toBe(false)
    expect(pushFires({ tags: ['v*'] }, branch)).toBe(false)
    expect(pushFires({ paths: ['src/**'] }, branch)).toBe(true)
    expect(pushFires(null, branch)).toBe(true)
  })

  it('counts a filter it cannot read as firing', () => {
    // `branches:` with no value parses as null; a stringified 'null' would read as a safe filter.
    expect(pushFires({ branches: null }, branch)).toBe(true)
    expect(pushFires({ branches: [] }, branch)).toBe(true)
    expect(pushFires({ 'branches-ignore': 3 }, branch)).toBe(true)
    expect(pushFires({ tags: { v: 1 } }, branch)).toBe(true)
  })

  it('treats a pattern it cannot compile as matching everything', () => {
    expect(filterPatternRegex('?x').test('anything')).toBe(true)
  })

  it('refuses an unparseable workflow, and reads a YAML-1.1 `on` key as `on`', () => {
    const files = {
      [LANE]: lane,
      '.github/workflows/broken.yml': 'on: [push\njobs: {}\n',
      '.github/workflows/yaml11.yml': 'true:\n  push:\n    branches: [main]\njobs: {}\n'
    }

    expect(workflowsFiredBy(files, branch).map((fired) => fired.path)).toEqual([
      '.github/workflows/broken.yml'
    ])
  })

  it('refuses a tree with a workflow the push would start, naming it', () => {
    const files = {
      [LANE]: lane,
      '.github/workflows/new-upstream.yml': 'on: [push]\njobs: {}\n',
      '.github/workflows/on-create.yml': 'on: create\njobs: {}\n',
      '.github/workflows/main-only.yml': 'on:\n  push:\n    branches: [main]\njobs: {}\n'
    }

    expect(workflowsFiredBy(files, branch).map((fired) => fired.path)).toEqual([
      '.github/workflows/new-upstream.yml',
      '.github/workflows/on-create.yml'
    ])
  })

  it('refuses a runner label the lane can reach that this fork does not provision', () => {
    const files = {
      [LANE]: `${lane.replace('jobs: {}', 'jobs:\n  t:\n    uses: ./.github/workflows/callee.yml')}`,
      '.github/workflows/callee.yml':
        'on: workflow_call\njobs:\n  a:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n'
    }
    const problems = refusalsFor({ remotes: ['origin'], dirty: [], files, branch })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("'blacksmith-2vcpu-ubuntu-2404'")
  })

  it('refuses a missing, undispatchable or unparseable lane', () => {
    const facts = (files) => ({ remotes: ['origin'], dirty: [], files, branch })

    expect(refusalsFor(facts({}))).toEqual([`${LANE} is not in the candidate's tree`])
    expect(refusalsFor(facts({ [LANE]: 'on: [schedule]\njobs: {}\n' }))).toEqual([
      `${LANE} in the candidate's tree has no workflow_dispatch trigger`
    ])
    const broken = refusalsFor(facts({ [LANE]: 'on: [workflow_dispatch\njobs: {}\n' }))
    expect(broken.length).toBeGreaterThan(0)
    expect(broken.some((problem) => problem.includes('does not parse'))).toBe(true)
  })

  it('refuses an origin that is not this fork', () => {
    const problems = refusalsFor({
      remotes: ['origin'],
      originUrl: 'https://github.com/stablyai/orca.git',
      dirty: [],
      files: { [LANE]: lane },
      branch
    })

    expect(problems).toEqual([
      'origin is https://github.com/stablyai/orca.git, not nplez1/orca — the candidate goes to the fork only'
    ])
    expect(isForkUrl('ssh://git@ssh.github.com:443/nplez1/orca.git')).toBe(true)
  })

  it('refuses a dirty tree, because the candidate is HEAD', () => {
    const problems = refusalsFor({
      remotes: ['origin'],
      dirty: [' M src/a.ts'],
      files: { [LANE]: lane },
      branch
    })

    expect(problems[0]).toContain('commit first')
  })
})

it('reads the run id gh prints for a dispatch', () => {
  expect(runIdFrom('https://github.com/nplez1/orca/actions/runs/43826476774\n')).toBe('43826476774')
  expect(runIdFrom('Created workflow_dispatch event for fork-main-tests.yml at x')).toBe(null)
})

it('accepts only a run that was not there before the dispatch', () => {
  const runs = [
    { databaseId: 2, headSha: 'abc' },
    { databaseId: 1, headSha: 'abc' }
  ]

  expect(newRunId(runs, 'abc', new Set(['1']))).toBe('2')
  expect(newRunId(runs, 'abc', new Set(['1', '2']))).toBe(null)
})

it('cleans up only candidates main already contains', () => {
  expect(isCandidateBranch('sync-candidate/0123456789ab')).toBe(true)
  expect(isCandidateBranch('sync-candidate/0123456789ab-keep')).toBe(false)

  const refs = [
    { sha: 'aaa', branch: 'sync-candidate/aaa' },
    { sha: 'bbb', branch: 'sync-candidate/bbb' }
  ]
  const { remove, keep } = partitionForCleanup(refs, (sha) => sha === 'aaa')

  expect(remove.map((ref) => ref.branch)).toEqual(['sync-candidate/aaa'])
  expect(keep.map((ref) => ref.branch)).toEqual(['sync-candidate/bbb'])
})
