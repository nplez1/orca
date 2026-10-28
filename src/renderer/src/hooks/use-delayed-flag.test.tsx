// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedFlag } from './use-delayed-flag'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let rendered: boolean[] = []

function Flag({ active, delayMs }: { active: boolean; delayMs?: number }): React.JSX.Element {
  const shown = useDelayedFlag(active, delayMs)
  rendered.push(shown)
  return <span>{shown ? 'shown' : 'hidden'}</span>
}

function render(active: boolean, delayMs?: number): void {
  act(() => {
    root.render(<Flag active={active} delayMs={delayMs} />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  rendered = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('useDelayedFlag', () => {
  it('stays hidden for an active flag that clears inside the delay', () => {
    render(true)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    render(false)

    expect(rendered).not.toContain(true)
  })

  it('shows a flag that outlasts the delay', () => {
    render(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(rendered.at(-1)).toBe(true)
  })

  it('hides again as soon as the flag clears', () => {
    render(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    render(false)

    expect(rendered.at(-1)).toBe(false)
  })
})
