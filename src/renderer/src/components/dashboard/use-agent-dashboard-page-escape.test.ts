// @vitest-environment happy-dom

import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAgentDashboardPageEscape } from './use-agent-dashboard-page-escape'

const overlay = vi.hoisted(() => ({ visible: false }))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlay: () => overlay.visible }))

afterEach(() => {
  cleanup()
  overlay.visible = false
  useAppStore.setState({ activeModal: 'none' })
  document.body.innerHTML = ''
})

function renderEscapeHook(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  renderHook(() => useAgentDashboardPageEscape(close))
  return { close }
}

describe('useAgentDashboardPageEscape', () => {
  it('closes the page on Escape outside any layer', () => {
    const { close } = renderEscapeHook()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an open menu or dialog', () => {
    const { close } = renderEscapeHook()
    overlay.visible = true
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })

  it('leaves Escape to a store modal that has not painted yet', () => {
    const { close } = renderEscapeHook()
    act(() => useAppStore.setState({ activeModal: 'quick-open' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })

  it('blurs a focused field before it closes the page', () => {
    const { close } = renderEscapeHook()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
    expect(close).not.toHaveBeenCalled()
  })

  it('never takes Escape from a terminal', () => {
    const { close } = renderEscapeHook()
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const textarea = document.createElement('textarea')
    terminal.append(textarea)
    document.body.append(terminal)
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(document.activeElement).toBe(textarea)
    expect(close).not.toHaveBeenCalled()
  })

  it('never takes Escape from the floating workspace over the page', () => {
    const { close } = renderEscapeHook()
    const panel = document.createElement('div')
    panel.setAttribute('data-floating-terminal-panel', '')
    const button = document.createElement('button')
    panel.append(button)
    document.body.append(panel)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })

  it('ignores an Escape another owner already handled', () => {
    const { close } = renderEscapeHook()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    document.body.dispatchEvent(event)
    expect(close).not.toHaveBeenCalled()
  })

  it('ignores keys other than Escape', () => {
    const { close } = renderEscapeHook()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(close).not.toHaveBeenCalled()
  })
})
