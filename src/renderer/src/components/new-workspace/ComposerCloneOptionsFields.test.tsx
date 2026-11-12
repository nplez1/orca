// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerCloneOptionsFields } from './ComposerCloneOptionsFields'
import type { RunTargetAutoClone } from './use-run-target-auto-clone'

const DEFAULT_URL = 'git@github.com:acme/app.git'

function cloneStub(overrides: Partial<RunTargetAutoClone> = {}): RunTargetAutoClone {
  return {
    status: { kind: 'idle' },
    overrides: { url: '', destination: '' },
    setOverrides: vi.fn(),
    defaultUrl: DEFAULT_URL,
    pendingHostId: null,
    blocksCreate: false,
    start: vi.fn(),
    retry: vi.fn(),
    cloneAs: vi.fn(),
    clear: vi.fn(),
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

async function renderFields(clone: RunTargetAutoClone): Promise<void> {
  await act(async () => {
    root.render(<ComposerCloneOptionsFields clone={clone} />)
  })
}

function transportToggle(): HTMLElement | null {
  return container.querySelector('[aria-label="Clone protocol"]')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ComposerCloneOptionsFields', () => {
  it('keeps the protocol toggle on the project remote when the override is only whitespace', async () => {
    await renderFields(cloneStub({ overrides: { url: '   ', destination: '' } }))

    // Why: the clone falls back to the project remote here, so a blank override must not hide the
    // toggle that rewrites the URL the clone will actually use.
    expect(transportToggle()).not.toBeNull()
  })
})
