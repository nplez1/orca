// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeBranchHostSelect } from './WorktreeBranchHostSelect'
import type { BranchGroupMember } from './worktree-list/grouping/row-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { remoteWorktree, worktree } from './worktree-list-groups-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Why: the sibling test mocks the menu primitives to assert option wiring. This
// one keeps the real Radix tree so a broken `asChild`/portal path fails here.
const members: BranchGroupMember[] = [
  { worktree, repo: undefined, hostId: LOCAL_EXECUTION_HOST_ID, hostLabel: 'Local Mac' },
  { worktree: remoteWorktree, repo: undefined, hostId: 'ssh:gpu-vm', hostLabel: 'GPU VM' }
]

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('WorktreeBranchHostSelect with the real dropdown primitive', () => {
  it('shows the selected host and opens the menu in a portal', () => {
    act(() => {
      root?.render(
        <WorktreeBranchHostSelect
          members={members}
          selectedHostId={LOCAL_EXECUTION_HOST_ID}
          groupKey="project:p1:wt-1"
          onSelectHost={vi.fn()}
        />
      )
    })

    const trigger = container!.querySelector('[data-branch-host-select]')
    expect(trigger?.textContent).toContain('Local Mac')

    act(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
      )
    })

    // Radix mounts the content in a body portal, outside the render container.
    expect(document.body.textContent).toContain('GPU VM')
  })
})
