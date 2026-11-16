import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

describe('web preload session summary', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Without a namespace the fallback proxy answered `undefined`, which the pane read as a
  // snapshot and threw on. Unpaired is the one case that needs no host, so it proves the
  // composition on its own.
  it('composes a summary namespace instead of falling through to the fallback proxy', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const answered = await globals.window.api.sessionSummary.open({ paneKey: 'tab-1:leaf-1' })

    expect(answered).toMatchObject({ paneKey: 'tab-1:leaf-1', status: 'failed' })
  })
})
