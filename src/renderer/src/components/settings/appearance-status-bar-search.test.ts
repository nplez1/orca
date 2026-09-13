import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog:
    <T>(loader: () => T) =>
    () =>
      loader()
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

import { getStatusBarToggles } from './appearance-status-bar-search'

describe('getStatusBarToggles', () => {
  it('includes Antigravity usage so Appearance can toggle the default-on status item', () => {
    const antigravityToggle = getStatusBarToggles().find((entry) => entry.id === 'antigravity')

    expect(antigravityToggle).toMatchObject({
      title: 'Antigravity Usage',
      description: 'Show Antigravity subscription usage in the status bar.',
      toggleDescription: 'Show Antigravity subscription usage for the active workspace.'
    })
    expect(antigravityToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'antigravity', 'usage', 'subscription', 'google'])
    )
  })

  it('includes MiniMax usage so Appearance can toggle the default-on status item', () => {
    const miniMaxToggle = getStatusBarToggles().find((entry) => entry.id === 'minimax')

    expect(miniMaxToggle).toMatchObject({
      title: 'MiniMax Usage',
      description: 'Show MiniMax subscription usage in the status bar.',
      toggleDescription: 'Show MiniMax subscription usage for the active workspace.'
    })
    expect(miniMaxToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'minimax', 'usage', 'subscription', 'cookie'])
    )
  })

  it('includes DeepSeek balance so Appearance can toggle the default-on status item', () => {
    const deepSeekToggle = getStatusBarToggles().find((entry) => entry.id === 'deepseek')

    expect(deepSeekToggle).toMatchObject({
      title: 'DeepSeek Balance',
      description: 'Show your DeepSeek account balance in the status bar.',
      toggleDescription: 'Show DeepSeek account balance in the status bar.'
    })
    expect(deepSeekToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'deepseek', 'usage', 'balance', 'credits', 'cny'])
    )
  })

  it('includes Fireworks.ai spend so Appearance can toggle the default-on status item', () => {
    const fireworksToggle = getStatusBarToggles().find((entry) => entry.id === 'fireworks')

    expect(fireworksToggle).toMatchObject({
      title: 'Fireworks.ai Spend',
      description: 'Show your Fireworks.ai rated spend in the status bar.',
      toggleDescription: 'Show Fireworks.ai rated spend in the status bar.'
    })
    expect(fireworksToggle?.keywords).toEqual(
      expect.arrayContaining(['status bar', 'fireworks', 'fireworks.ai', 'usage', 'spend', 'cost'])
    )
  })
})
