import { describe, expect, it } from 'vitest'
import {
  candidateRef,
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
    expect(pushFires({ tags: ['v*'] }, branch)).toBe(false)
    expect(pushFires({ paths: ['src/**'] }, branch)).toBe(true)
    expect(pushFires(null, branch)).toBe(true)
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

it('cleans up only candidates main already contains', () => {
  const refs = [
    { sha: 'aaa', branch: 'sync-candidate/aaa' },
    { sha: 'bbb', branch: 'sync-candidate/bbb' }
  ]
  const { remove, keep } = partitionForCleanup(refs, (sha) => sha === 'aaa')

  expect(remove.map((ref) => ref.branch)).toEqual(['sync-candidate/aaa'])
  expect(keep.map((ref) => ref.branch)).toEqual(['sync-candidate/bbb'])
})
