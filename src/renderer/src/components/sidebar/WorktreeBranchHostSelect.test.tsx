// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeBranchHostSelect } from './WorktreeBranchHostSelect'
import type { BranchGroupMember } from './worktree-list/grouping/row-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { remoteWorktree, worktree } from './worktree-list-groups-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react')
  type RadioItemProps = {
    children: ReactNode
    onValueChange?: (value: string) => void
    value: string
  }
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div data-branch-host-menu="">{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange
    }: {
      children: ReactNode
      onValueChange?: (value: string) => void
    }) => (
      <div>
        {ReactModule.Children.map(children, (child) =>
          ReactModule.isValidElement<RadioItemProps>(child)
            ? ReactModule.cloneElement(child, { onValueChange })
            : child
        )}
      </div>
    ),
    DropdownMenuRadioItem: ({ children, onValueChange, value }: RadioItemProps) => (
      <button type="button" data-host-option={value} onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    )
  }
})

const members: BranchGroupMember[] = [
  { hostId: LOCAL_EXECUTION_HOST_ID, hostLabel: 'Local Mac', repo: undefined, worktree },
  { hostId: 'ssh:gpu-vm', hostLabel: 'GPU VM', repo: undefined, worktree: remoteWorktree }
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

function renderSelect(selectedHostId: BranchGroupMember['hostId']): {
  onSelectHost: ReturnType<typeof vi.fn>
} {
  const onSelectHost = vi.fn()
  act(() => {
    root?.render(
      <WorktreeBranchHostSelect
        members={members}
        selectedHostId={selectedHostId}
        groupKey="project:p1:wt-local"
        onSelectHost={onSelectHost}
      />
    )
  })
  return { onSelectHost }
}

describe('WorktreeBranchHostSelect', () => {
  it('lists every host', () => {
    renderSelect(LOCAL_EXECUTION_HOST_ID)

    const options = [...container!.querySelectorAll('[data-host-option]')].map((element) =>
      element.getAttribute('data-host-option')
    )
    expect(options).toEqual([LOCAL_EXECUTION_HOST_ID, 'ssh:gpu-vm'])
    expect(container!.textContent).toContain('GPU VM')
  })

  it('reports the host the user picked', () => {
    const { onSelectHost } = renderSelect(LOCAL_EXECUTION_HOST_ID)

    act(() => {
      container!.querySelector<HTMLButtonElement>('[data-host-option="ssh:gpu-vm"]')?.click()
    })

    expect(onSelectHost).toHaveBeenCalledWith('project:p1:wt-local', 'ssh:gpu-vm')
  })

  it('shows the selected host on the trigger', () => {
    renderSelect('ssh:gpu-vm')

    expect(container!.querySelector('[data-branch-host-select]')?.textContent).toContain('GPU VM')
  })
})
