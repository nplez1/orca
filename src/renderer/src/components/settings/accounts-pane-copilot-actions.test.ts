import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
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
  copilotConfigured: boolean
  copilotCredentialBusy: boolean
}

// Why: the actions destructure their inputs once, exactly like a React render, so
// a harness recreates them per call and feeds every setter back into one state cell.
function makeHarness(initial: Partial<CopilotDraftState> = {}) {
  const state: CopilotDraftState = {
    copilotTokenDraft: '',
    copilotEnterpriseSlugDraft: '',
    copilotConfigured: false,
    copilotCredentialBusy: false,
    ...initial
  }
  const recordFeatureInteraction = vi.fn((_id: FeatureInteractionId) => {})
  const actions = createCopilotCredentialActions({
    copilotTokenDraft: state.copilotTokenDraft,
    copilotConfigured: state.copilotConfigured,
    setCopilotTokenDraft: (value) => {
      state.copilotTokenDraft = typeof value === 'function' ? value(state.copilotTokenDraft) : value
    },
    copilotEnterpriseSlugDraft: state.copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft: (value) => {
      state.copilotEnterpriseSlugDraft =
        typeof value === 'function' ? value(state.copilotEnterpriseSlugDraft) : value
    },
    setCopilotConfigured: (value) => {
      state.copilotConfigured = typeof value === 'function' ? value(state.copilotConfigured) : value
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
    apiMocks.save.mockResolvedValue({ configured: true, enterpriseSlug: 'acme' })
    const { state, recordFeatureInteraction, saveCopilotCredentials } = makeHarness({
      copilotTokenDraft: '  ghp_token  ',
      copilotEnterpriseSlugDraft: '  acme  '
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).toHaveBeenCalledWith('ghp_token', 'acme')
    expect(state.copilotConfigured).toBe(true)
    // The token never comes back, so its draft is dropped; the slug is echoed.
    expect(state.copilotTokenDraft).toBe('')
    expect(state.copilotEnterpriseSlugDraft).toBe('acme')
    expect(state.copilotCredentialBusy).toBe(false)
    expect(recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(toastMocks.success).toHaveBeenCalledWith('GitHub Copilot credentials saved.')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('sends a blank token so an existing credential can have its slug edited alone', async () => {
    apiMocks.save.mockResolvedValue({ configured: true, enterpriseSlug: 'acme' })
    const { state, saveCopilotCredentials } = makeHarness({
      copilotConfigured: true,
      copilotTokenDraft: '',
      copilotEnterpriseSlugDraft: 'acme'
    })

    await saveCopilotCredentials()

    expect(apiMocks.save).toHaveBeenCalledWith('', 'acme')
    expect(state.copilotConfigured).toBe(true)
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

  it('reports the failure when main does not report the credential as stored', async () => {
    apiMocks.save.mockResolvedValue({ configured: false, enterpriseSlug: null })
    const { state, saveCopilotCredentials } = makeHarness({ copilotTokenDraft: 'ghp_token' })

    await saveCopilotCredentials()

    expect(state.copilotConfigured).toBe(false)
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

  it('clears both drafts and the configured flag on forget', async () => {
    apiMocks.clear.mockResolvedValue({ configured: false, enterpriseSlug: null })
    const { state, recordFeatureInteraction, clearCopilotCredentials } = makeHarness({
      copilotConfigured: true,
      copilotEnterpriseSlugDraft: 'acme'
    })

    await clearCopilotCredentials()

    expect(state.copilotConfigured).toBe(false)
    expect(state.copilotTokenDraft).toBe('')
    expect(state.copilotEnterpriseSlugDraft).toBe('')
    expect(state.copilotCredentialBusy).toBe(false)
    expect(recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('keeps the stored flag when forget fails and clears the busy flag', async () => {
    apiMocks.clear.mockRejectedValue(new Error('IPC unavailable'))
    const { state, clearCopilotCredentials } = makeHarness({ copilotConfigured: true })

    await clearCopilotCredentials()

    expect(state.copilotConfigured).toBe(true)
    expect(state.copilotCredentialBusy).toBe(false)
    expect(toastMocks.error).toHaveBeenCalledWith('GitHub Copilot credential update failed.', {
      description: 'IPC unavailable'
    })
  })
})
