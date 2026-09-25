// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { WorktreeSymlinksSection } from './WorktreeSymlinksSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const REPO: Repo = {
  id: 'repo-1',
  path: '/home/user/project',
  displayName: 'My Project',
  badgeColor: '#000000',
  addedAt: 0,
  executionHostId: 'ssh:host-1'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('WorktreeSymlinksSection shared directory mode', () => {
  it('defaults to symlinks and persists the selected APFS fallback', () => {
    const updateRepo = vi.fn()
    act(() => {
      root.render(
        React.createElement(WorktreeSymlinksSection, {
          repo: REPO,
          updateRepo
        })
      )
    })

    const select = container.querySelector<HTMLSelectElement>('select')
    expect(select?.value).toBe('symlink')

    act(() => {
      if (!select) {
        throw new Error('shared directory mode selector not found')
      }
      select.value = 'apfs-copy'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { sharedDirectoriesMode: 'apfs-copy' })
  })
})
