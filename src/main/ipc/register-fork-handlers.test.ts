import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { registerForkHandlers } from './register-fork-handlers'

const mocks = vi.hoisted(() => ({
  registerJenkinsHandlers: vi.fn(),
  registerSessionSummaryHandlers: vi.fn(),
  registerUiHangDiagnosticsHandlers: vi.fn(),
  registerDeepSeekCredentialsHandlers: vi.fn(),
  registerFireworksCredentialsHandlers: vi.fn(),
  registerCopilotCredentialsHandlers: vi.fn()
}))

vi.mock('./jenkins', () => ({
  registerJenkinsHandlers: mocks.registerJenkinsHandlers
}))
vi.mock('./session-summary', () => ({
  registerSessionSummaryHandlers: mocks.registerSessionSummaryHandlers
}))
vi.mock('./ui-hang-diagnostics', () => ({
  registerUiHangDiagnosticsHandlers: mocks.registerUiHangDiagnosticsHandlers
}))
vi.mock('./deepseek-credentials', () => ({
  registerDeepSeekCredentialsHandlers: mocks.registerDeepSeekCredentialsHandlers
}))
vi.mock('./fireworks-credentials', () => ({
  registerFireworksCredentialsHandlers: mocks.registerFireworksCredentialsHandlers
}))
vi.mock('./copilot-credentials', () => ({
  registerCopilotCredentialsHandlers: mocks.registerCopilotCredentialsHandlers
}))

const settings = createGlobalSettingsFixture({ uiHangDiagnosticsEnabled: true })
const store = { getSettings: () => settings }

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
})

describe('registerForkHandlers', () => {
  it('mounts every fork handler group', () => {
    registerForkHandlers({ store, rateLimits: null })

    expect(mocks.registerJenkinsHandlers).toHaveBeenCalledOnce()
    expect(mocks.registerUiHangDiagnosticsHandlers).toHaveBeenCalledWith(store)
    expect(mocks.registerDeepSeekCredentialsHandlers).toHaveBeenCalledWith(null)
    expect(mocks.registerFireworksCredentialsHandlers).toHaveBeenCalledWith(null)
    expect(mocks.registerCopilotCredentialsHandlers).toHaveBeenCalledWith(null)
  })

  it('hands session summary a getter, so a settings change is not snapshotted at registration', () => {
    registerForkHandlers({ store, rateLimits: null })

    const getSettings: () => unknown = mocks.registerSessionSummaryHandlers.mock.calls[0]?.[0]
    expect(getSettings()).toBe(settings)
  })

  it('forwards the rate-limit service to every credential group, including a null one', () => {
    registerForkHandlers({ store, rateLimits: null })

    expect(mocks.registerDeepSeekCredentialsHandlers).toHaveBeenCalledWith(null)
    expect(mocks.registerFireworksCredentialsHandlers).toHaveBeenCalledWith(null)
    expect(mocks.registerCopilotCredentialsHandlers).toHaveBeenCalledWith(null)
  })
})
