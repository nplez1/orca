// @vitest-environment happy-dom

import { cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installAppKeyboardRouter } from '@/lib/keyboard/app-keyboard-router'
import { useSkillsPageKeyboardNavigation } from './use-skills-page-keyboard-navigation'

const overlay = vi.hoisted(() => ({ visible: false }))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlay: () => overlay.visible }))

beforeAll(() => installAppKeyboardRouter())

afterEach(() => {
  cleanup()
  overlay.visible = false
  document.body.innerHTML = ''
})

function renderSkillsEscape(
  overrides: {
    selectionMode?: 'share' | 'delete' | null
    view?: 'skills' | 'shared'
  } = {}
): { closeSkillsPage: ReturnType<typeof vi.fn>; exitSelection: ReturnType<typeof vi.fn> } {
  const closeSkillsPage = vi.fn()
  const exitSelection = vi.fn()
  const exitSharedLinks = vi.fn()
  renderHook(() =>
    useSkillsPageKeyboardNavigation({
      closeSkillsPage,
      exitSelection,
      exitSharedLinks,
      selectionMode: overrides.selectionMode ?? null,
      view: overrides.view ?? 'skills'
    })
  )
  return { closeSkillsPage, exitSelection }
}

describe('useSkillsPageKeyboardNavigation', () => {
  // The page has no close button, so Escape is its only in-page exit.
  it('closes the page on Escape outside any layer', () => {
    const { closeSkillsPage } = renderSkillsEscape()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeSkillsPage).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an open menu or dialog', () => {
    const { closeSkillsPage } = renderSkillsEscape()
    overlay.visible = true
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeSkillsPage).not.toHaveBeenCalled()
  })

  it('blurs a focused field before it leaves the page', () => {
    const { closeSkillsPage } = renderSkillsEscape()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
    expect(closeSkillsPage).not.toHaveBeenCalled()
  })

  it('exits selection mode instead of the page', () => {
    const { closeSkillsPage, exitSelection } = renderSkillsEscape({ selectionMode: 'delete' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(exitSelection).toHaveBeenCalledTimes(1)
    expect(closeSkillsPage).not.toHaveBeenCalled()
  })

  it('ignores keys other than Escape', () => {
    const { closeSkillsPage } = renderSkillsEscape()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(closeSkillsPage).not.toHaveBeenCalled()
  })
})
