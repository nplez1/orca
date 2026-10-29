// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { BrowserLinkRoutingSetting } from './BrowserLinkRoutingSetting'

const fake = vi.hoisted(() => ({ query: '' }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: fake.query })
}))

function chooser(): HTMLElement {
  return screen.getByRole('radiogroup', { name: 'Default link destination' })
}

function option(name: string): HTMLElement {
  return screen.getByRole('radio', { name })
}

function renderSetting(openLinksInApp: boolean): ReturnType<typeof vi.fn> {
  const updateSettings = vi.fn()
  render(
    <BrowserLinkRoutingSetting
      settings={{ ...getDefaultSettings('/synthetic'), openLinksInApp }}
      linkRoutingDescription="Open http(s) links in Orca's built-in browser."
      isMac
      updateSettings={updateSettings}
    />
  )
  return updateSettings
}

describe('BrowserLinkRoutingSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.query = ''
  })
  afterEach(cleanup)

  it('names both destinations instead of hiding the choice behind a switch', () => {
    renderSetting(true)

    expect(chooser()).toBeTruthy()
    expect(option('In-App Browser').getAttribute('aria-checked')).toBe('true')
    expect(option('System Browser').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the in-app preference and answers the first-use prompt', () => {
    const updateSettings = renderSetting(false)

    fireEvent.click(option('In-App Browser'))

    expect(updateSettings).toHaveBeenCalledWith({
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true
    })
  })

  it('writes the system-browser preference and answers the first-use prompt', () => {
    const updateSettings = renderSetting(true)

    fireEvent.click(option('System Browser'))

    expect(updateSettings).toHaveBeenCalledWith({
      openLinksInApp: false,
      openLinksInAppPreferencePrompted: true
    })
  })

  it('stays hidden when the search query matches nothing here', () => {
    fake.query = 'default home page'

    renderSetting(true)

    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})
