import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { CopilotCredentialSource } from './accounts-pane-types'
import { createCopilotCredentialActions } from './accounts-pane-copilot-actions'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    success: toastMocks.success,
    error: toastMocks.error
  }
}))

const apiMocks = {
  getStatus: vi.fn(),
  save: vi.fn(),
  clear: vi.fn()
}

// @ts-expect-error test window mock
globalThis.window = { api: { copilotCredentials: apiMocks } }

type CopilotDraftState = {
  copilotTokenDraft: string
  copilotEnterpriseSlugDraft: string
  copilotCredentialSource: CopilotCredentialSource
  copilotGhSetupHint: string | null
  copilotCredentialBusy: boolean
}

// Why: the actions destructure their inputs once, exactly like a React render, so
// a harness recreates them per call and feeds every setter back into one state cell.
function makeHarness(initial: Partial<CopilotDraftState> = {}) {
  const state: CopilotDraftState = {
    copilotTokenDraft: '',
    copilotEnterpriseSlugDraft: '',
    copilotCredentialSource: 'none',
    copilotGhSetupHint: null,
    copilotCredentialBusy: false,
    ...initial
  }
  const recordFeatureInteraction = vi.fn((_id: FeatureInteractionId) => {})
  const actions = createCopilotCredentialActions({
    copilotTokenDraft: state.copilotTokenDraft,
    copilotCredentialSource: state.copilotCredentialSource,
    setCopilotTokenDraft: (value) => {
      state.copilotTokenDraft = typeof value === 'function' ? value(state.copilotTokenDraft) : value
    },
    copilotEnterpriseSlugDraft: state.copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft: (value) => {
      state.copilotEnterpriseSlugDraft =
        typeof value === 'function' ? value(state.copilotEnterpriseSlugDraft) : value
    },
    setCopilotCredentialSource: (value) => {
      state.copilotCredentialSource =
        typeof value === 'function' ? value(state.copilotCredentialSource) : value
    },
    setCopilotGhSetupHint: (value) => {
      state.copilotGhSetupHint =
        typeof value === 'function' ? value(state.copilotGhSetupHint) : value
    },
    setCopilotCredentialBusy: (value) => {
      state.copilotCredentialBusy =
        typeof value === 'function' ? value(state.copilotCredentialBusy) : value
    },
    recordFeatureInteraction
  })
  return { state, recordFeatureInteraction, ...actions }
}

describe('createCopilotCredentialActions', () => {
  beforeEach(() => {
    apiMocks.getStatus.mockReset()
    apiMocks.save.mockReset()
    apiMocks.clear.mockReset()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
  })

  it('saves the drafted token and echoes main’s normalized slug back', async () => {
    apiMocks.save.mockResolvedValue({
      configured: true,
      enterpriseSlug: 'acme',
      source: 'stored',
      ghSetupHint: null
    })
    const { state, recordFeatureInteraction, saveCopilotCredentials } = makeHarness({
      copilotTokenDraft: '  ghp_token  ',
      copilotEnterpriseSlugDraft: '  acme  '
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).toHaveBeenCalledWith('ghp_token', 'acme')
    expect(state.copilotCredentialSource).toBe('stored')
    expect(state.copilotGhSetupHint).toBeNull()
    // The token never comes back, so its draft is dropped; the slug is echoed.
    expect(state.copilotTokenDraft).toBe('')
    expect(state.copilotEnterpriseSlugDraft).toBe('acme')
    expect(state.copilotCredentialBusy).toBe(false)
    expect(recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(toastMocks.success).toHaveBeenCalledWith('GitHub Copilot credentials saved.')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('sends a blank token so an existing credential can have its slug edited alone', async () => {
    apiMocks.save.mockResolvedValue({
      configured: true,
      enterpriseSlug: 'acme',
      source: 'stored',
      ghSetupHint: null
    })
    const { state, saveCopilotCredentials } = makeHarness({
      copilotCredentialSource: 'stored',
      copilotTokenDraft: '',
      copilotEnterpriseSlugDraft: 'acme'
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).toHaveBeenCalledWith('', 'acme')
    expect(state.copilotCredentialSource).toBe('stored')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('refuses a blank token when nothing is stored yet', async () => {
    const { state, recordFeatureInteraction, saveCopilotCredentials } = makeHarness({
      copilotTokenDraft: '   '
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('GitHub token is required.')
    expect(recordFeatureInteraction).not.toHaveBeenCalled()
    expect(state.copilotCredentialBusy).toBe(false)
  })

  it('refuses a blank token while the GitHub CLI supplies the credential', async () => {
    // Why: main can only keep a token it has stored, so a gh-sourced credential
    // cannot satisfy the "blank token means keep what is there" path.
    const { state, saveCopilotCredentials } = makeHarness({
      copilotCredentialSource: 'github-cli',
      copilotEnterpriseSlugDraft: 'acme'
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('GitHub token is required.')
    expect(state.copilotCredentialSource).toBe('github-cli')
  })

  it('reports the failure when main does not report the credential as stored', async () => {
    apiMocks.save.mockResolvedValue({
      configured: false,
      enterpriseSlug: null,
      source: 'none',
      ghSetupHint: null
    })
    const { state, saveCopilotCredentials } = makeHarness({ copilotTokenDraft: 'ghp_token' })

    await saveCopilotCredentials()

    expect(state.copilotCredentialSource).toBe('none')
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('GitHub Copilot credential update failed.', {
      description: 'GitHub Copilot credentials were not saved.'
    })
    expect(state.copilotCredentialBusy).toBe(false)
  })

  it('surfaces a bridge rejection with its message', async () => {
    apiMocks.save.mockRejectedValue(new Error('GitHub enterprise slug is required'))
    const { saveCopilotCredentials } = makeHarness({ copilotTokenDraft: 'ghp_token' })

    await saveCopilotCredentials()

    expect(toastMocks.error).toHaveBeenCalledWith('GitHub Copilot credential update failed.', {
      description: 'GitHub enterprise slug is required'
    })
  })

  it('clears both drafts and the source on forget', async () => {
    apiMocks.clear.mockResolvedValue({
      configured: false,
      enterpriseSlug: null,
      source: 'none',
      ghSetupHint: null
    })
    const { state, recordFeatureInteraction, clearCopilotCredentials } = makeHarness({
      copilotCredentialSource: 'stored',
      copilotEnterpriseSlugDraft: 'acme'
    })

    await clearCopilotCredentials()

    expect(state.copilotCredentialSource).toBe('none')
    expect(state.copilotTokenDraft).toBe('')
    expect(state.copilotEnterpriseSlugDraft).toBe('')
    expect(state.copilotCredentialBusy).toBe(false)
    expect(recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('adopts the GitHub CLI credential forget falls back to', async () => {
    apiMocks.clear.mockResolvedValue({
      configured: true,
      enterpriseSlug: 'acme',
      source: 'github-cli',
      ghSetupHint: null
    })
    const { state, clearCopilotCredentials } = makeHarness({
      copilotCredentialSource: 'stored',
      copilotEnterpriseSlugDraft: 'stored-enterprise'
    })

    await clearCopilotCredentials()

    expect(state.copilotCredentialSource).toBe('github-cli')
    expect(state.copilotGhSetupHint).toBeNull()
    expect(state.copilotEnterpriseSlugDraft).toBe('acme')
  })

  it('surfaces the GitHub CLI setup hint when clearing leaves nothing configured', async () => {
    apiMocks.clear.mockResolvedValue({
      configured: false,
      enterpriseSlug: null,
      source: 'none',
      ghSetupHint: 'gh auth login'
    })
    const { state, clearCopilotCredentials } = makeHarness({ copilotCredentialSource: 'stored' })

    await clearCopilotCredentials()

    expect(state.copilotCredentialSource).toBe('none')
    expect(state.copilotGhSetupHint).toBe('gh auth login')
  })

  it('keeps the stored source when forget fails and clears the busy flag', async () => {
    apiMocks.clear.mockRejectedValue(new Error('IPC unavailable'))
    const { state, clearCopilotCredentials } = makeHarness({
      copilotCredentialSource: 'stored'
    })

    await clearCopilotCredentials()

    expect(state.copilotCredentialSource).toBe('stored')
    expect(state.copilotCredentialBusy).toBe(false)
    expect(toastMocks.error).toHaveBeenCalledWith('GitHub Copilot credential update failed.', {
      description: 'IPC unavailable'
    })
  })
})
