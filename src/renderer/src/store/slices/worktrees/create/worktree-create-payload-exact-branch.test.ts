import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams
} from './worktree-create-payload'

const request = {
  repoId: 'repo-1',
  name: 'fix-login',
  baseBranch: 'origin/fix-login',
  setupDecision: 'inherit',
  creationId: 'creation-1'
} as const

describe('exact branch requests on the wire', () => {
  it('carries the refusal to rename on both transports', () => {
    const attempt = { name: request.name, branchNameOverride: 'fix-login' }

    expect(
      buildLocalWorktreeCreateArgs({ ...request, options: { exactBranchName: true } }, attempt)
    ).toMatchObject({ exactBranchName: true })

    expect(
      buildRuntimeWorktreeCreateParams({ ...request, options: { exactBranchName: true } }, attempt)
    ).toMatchObject({ exactBranchName: true })
  })

  it('leaves an ordinary create free to suffix a collision', () => {
    const attempt = { name: request.name, branchNameOverride: 'fix-login' }

    expect(buildLocalWorktreeCreateArgs(request, attempt)).not.toHaveProperty('exactBranchName')
    expect(buildRuntimeWorktreeCreateParams(request, attempt)).not.toHaveProperty('exactBranchName')
  })
})
