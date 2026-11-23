import { describe, expect, it, vi } from 'vitest'
import { PrActionsEngine } from './pr-actions-engine'
import './pr-action-mutation-contract'
import type { PrActionMutations } from './pr-action-mutation-contract'
import type { GitHubPrMutationOutcome } from '../../github-operations/github-pr-mutation-outcome'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('PrActionsEngine — PR identity changes', () => {
  it('clears in-flight state when only the GitHub host changes', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const mutations: PrActionMutations = {
      mergePR: async () => ({ ok: true }),
      setPRAutoMerge: async () => slow.promise,
      updatePRState: async () => ({ ok: true }),
      markReadyForReview: async () => ({ ok: true }),
      markDraft: async () => ({ ok: true }),
      requestReviewers: async () => ({ ok: true }),
      removeReviewers: async () => ({ ok: true }),
      rerunChecks: async () => ({ ok: true })
    }
    const refetch = vi.fn()
    const onChange = vi.fn()
    const baseConfig = {
      mutations,
      prNumber: 1,
      refetch,
      onChange
    }
    const engine = new PrActionsEngine({
      ...baseConfig,
      prRepo: { owner: 'acme', repo: 'widgets' }
    })

    const action = engine.setAutoMerge(true)
    expect(engine.resolveAutoMerge(false)).toBe(true)
    expect(engine.isBusy({ kind: 'autoMerge' })).toBe(true)

    engine.updateConfig({
      ...baseConfig,
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }
    })
    expect(engine.resolveAutoMerge(false)).toBe(false)
    expect(engine.busy).toBeNull()

    slow.resolve({ ok: true })
    await action
    expect(refetch).not.toHaveBeenCalled()
  })
})

describe('PrActionsEngine — merge arguments', () => {
  function engineWithMerge(mergePR: PrActionMutations['mergePR']) {
    return new PrActionsEngine({
      mutations: {
        mergePR,
        setPRAutoMerge: async () => ({ ok: true }),
        updatePRState: async () => ({ ok: true }),
        markReadyForReview: async () => ({ ok: true }),
        markDraft: async () => ({ ok: true }),
        requestReviewers: async () => ({ ok: true }),
        removeReviewers: async () => ({ ok: true }),
        rerunChecks: async () => ({ ok: true })
      },
      prNumber: 7,
      prRepo: { owner: 'acme', repo: 'widgets' },
      refetch: vi.fn(),
      onChange: vi.fn()
    })
  }

  it('keeps the head fence on a merge that bypasses branch protection', async () => {
    const mergePR = vi.fn<PrActionMutations['mergePR']>(async () => ({ ok: true }))
    await engineWithMerge(mergePR).merge('squash', 'abc123', true)
    expect(mergePR).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: 'abc123', bypassBranchProtection: true })
    )
  })

  it('sends no bypass field for an ordinary merge', async () => {
    const mergePR = vi.fn<PrActionMutations['mergePR']>(async () => ({ ok: true }))
    await engineWithMerge(mergePR).merge('merge', 'abc123')
    expect(mergePR).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: 'abc123' }))
    expect(mergePR.mock.calls[0][0]).not.toHaveProperty('bypassBranchProtection')
  })
})
