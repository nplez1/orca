// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'

const boardProps = vi.hoisted(() => {
  const props: { headerActions: ReactNode } = { headerActions: null }
  return { props }
})

vi.mock('./AgentKanbanBoard', () => ({
  AgentKanbanBoard: ({ headerActions }: { headerActions?: ReactNode }) => {
    boardProps.props.headerActions = headerActions ?? null
    return null
  }
}))
vi.mock('./useDashboardSnapshot', () => ({ useDashboardSnapshot: () => null }))

import { DashboardPopoutRoot } from './DashboardPopoutRoot'

describe('DashboardPopoutRoot', () => {
  const performNativePaste = vi.fn()
  const performNativeSelectionAction = vi.fn()
  let emitAppMenuPaste: (() => void) | null = null
  let emitAppMenuSelectionAction: ((action: 'copy' | 'select-all') => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    boardProps.props.headerActions = null
    emitAppMenuPaste = null
    emitAppMenuSelectionAction = null
    Object.assign(window, {
      api: {
        ui: {
          readClipboardText: vi.fn(async () => ''),
          performNativePaste,
          performNativeSelectionAction,
          onAppMenuPaste: (listener: () => void) => {
            emitAppMenuPaste = listener
            return vi.fn()
          },
          onEditableContextPaste: () => vi.fn(),
          onAppMenuSelectionAction: (listener: (action: 'copy' | 'select-all') => void) => {
            emitAppMenuSelectionAction = listener
            return vi.fn()
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  // Why: this window has no App shell, so without the hooks the terminal
  // preview's ownership listeners would never see a menu command at all.
  it('translates app-menu clipboard IPC into renderer ownership events', async () => {
    const onPaste = vi.fn()
    const onSelectionAction = vi.fn()
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
    render(<DashboardPopoutRoot />)
    expect(emitAppMenuPaste).not.toBeNull()
    expect(emitAppMenuSelectionAction).not.toBeNull()

    await act(async () => emitAppMenuPaste!())
    act(() => emitAppMenuSelectionAction!('select-all'))
    window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)

    expect(onPaste).toHaveBeenCalledOnce()
    expect(onSelectionAction).toHaveBeenCalledOnce()
    // Unclaimed here (no preview mounted), so both still reach the native path.
    expect(performNativePaste).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  // Why: without a header settings menu the pop-out is a one-way trip — the
  // mode control is the only route back to the in-window board.
  it('gives the pop-out board the dashboard settings menu', () => {
    render(<DashboardPopoutRoot />)
    expect(boardProps.props.headerActions).not.toBeNull()

    const view = render(<TooltipProvider>{boardProps.props.headerActions}</TooltipProvider>)
    expect(
      view.container.querySelector('button[aria-label="Agent Dashboard settings"]')
    ).not.toBeNull()
  })
})
