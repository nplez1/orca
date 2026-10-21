// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_REPOSITORY_URL } from '../../../../shared/orca-repository'
import { GeneralSupportSection } from './GeneralSupportSection'

const checkOrcaStarred = vi.fn()
const starOrca = vi.fn()
const openUrl = vi.fn()
const complete = vi.fn()

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

beforeEach(() => {
  checkOrcaStarred.mockReset()
  starOrca.mockReset()
  openUrl.mockReset()
  complete.mockReset()
  openUrl.mockResolvedValue(undefined)
  complete.mockResolvedValue(undefined)
  Object.assign(window, {
    api: {
      gh: { checkOrcaStarred, starOrca },
      shell: { openUrl },
      starNag: { complete }
    }
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('GeneralSupportSection star target', () => {
  it('uses the direct star path from Settings when gh reports no star', async () => {
    checkOrcaStarred.mockResolvedValue(false)
    starOrca.mockResolvedValue(true)
    render(<GeneralSupportSection hasPrecedingSections={false} />)

    const starButton = await screen.findByRole('button', { name: /star/i })
    await act(async () => {
      starButton.click()
    })

    expect(starOrca).toHaveBeenCalledWith('settings')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens this build repository when gh cannot report a star state', async () => {
    checkOrcaStarred.mockResolvedValue(null)
    render(<GeneralSupportSection hasPrecedingSections={false} />)

    // Why: the fallback URL was a literal here too, so a fork's Settings pane sent
    // users to upstream and the fork received no star.
    const fallbackButton = await screen.findByRole('button', { name: /open github/i })
    await act(async () => {
      fallbackButton.click()
    })

    expect(openUrl).toHaveBeenCalledWith(ORCA_REPOSITORY_URL)
  })
})
