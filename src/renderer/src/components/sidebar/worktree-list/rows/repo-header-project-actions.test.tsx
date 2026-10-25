// @vitest-environment happy-dom

import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupHostOption } from '@/components/settings/repository/execution/repository-host-setup-options'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'

const addToHost = vi.hoisted(() => ({ addToHost: vi.fn(), getAddToHostOptions: vi.fn() }))

vi.mock('../../use-project-add-to-host', () => ({ useProjectAddToHost: () => addToHost }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => (
    <div data-tooltip-content>{children}</div>
  ),
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double clones whatever trigger element the component passes, so the element's prop type is irrelevant here.
        children as ReactElement<Record<string, unknown>>
      )
    }
    return <span>{children}</span>
  }
}))

// Why: the real primitives portal their content, so every menu case renders inline here.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div data-menu-content>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button
      type="button"
      data-menu-item
      aria-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr data-menu-separator />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div data-menu-sub>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-content>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div data-menu-sub-trigger>{children}</div>
  )
}))

const repo: Repo = {
  id: 'local-repo',
  path: '/Users/alice/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  addedAt: 100,
  kind: 'git'
}

let container: HTMLDivElement
let root: Root

function makeActions(): RepoHeaderProjectActions {
  return {
    getWorktreeVisibilityDefaults: () => undefined,
    onOpenRepoSettings: vi.fn(),
    onOpenWorktreeVisibility: vi.fn(),
    onCreateGroupFromRepo: vi.fn(),
    onMoveProjectToGroup: vi.fn(),
    onRemoveProjectFromGroup: vi.fn(),
    onRemoveProject: vi.fn(),
    onCreateForRepo: vi.fn()
  }
}

function renderMenu(hostOptions: readonly SetupHostOption[]): void {
  addToHost.getAddToHostOptions.mockReturnValue(hostOptions)
  act(() => {
    root.render(
      <RepoHeaderProjectActionsMenu
        repo={repo}
        label="Orca"
        projectGroups={[]}
        actions={makeActions()}
      />
    )
  })
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-menu-item]')).find((item) =>
    item.textContent?.includes(label)
  )
}

beforeEach(() => {
  addToHost.addToHost.mockReset()
  addToHost.getAddToHostOptions.mockReset()
  addToHost.getAddToHostOptions.mockReturnValue([])
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

describe('project menu Add to…', () => {
  it('offers every host the project can still be added to', () => {
    renderMenu([
      {
        id: 'ssh:build-box',
        label: 'Build Box',
        detail: 'build-box.local',
        isAvailable: true,
        canUsePathActions: true
      },
      {
        id: 'runtime:win',
        label: 'Windows',
        detail: 'win-box.tailnet',
        isAvailable: true,
        canUsePathActions: true
      }
    ])

    expect(container.textContent).toContain('Add to…')
    expect(container.textContent).toContain('Build Box')
    expect(container.textContent).toContain('Windows')

    act(() => {
      menuItem('Build Box')?.click()
    })

    expect(addToHost.addToHost).toHaveBeenCalledWith(repo, 'ssh:build-box')
  })

  it('shows no Add to… item when no host lacks a setup', () => {
    renderMenu([])

    expect(container.textContent).not.toContain('Add to…')
    // The other project actions are untouched by an empty host list.
    expect(container.textContent).toContain('Project Settings')
    expect(container.textContent).toContain('Remove Project')
  })

  it('renders an unavailable host disabled with its reason and never selects it', () => {
    renderMenu([
      {
        id: 'runtime:stale',
        label: 'Old Box',
        detail: 'Update Orca on this host to set up projects',
        isAvailable: false,
        canUsePathActions: false
      }
    ])

    const item = menuItem('Old Box')
    expect(item?.textContent).toContain('Update Orca on this host to set up projects')
    expect(item?.getAttribute('aria-disabled')).toBe('true')

    act(() => {
      item?.click()
    })

    expect(addToHost.addToHost).not.toHaveBeenCalled()
  })
})
