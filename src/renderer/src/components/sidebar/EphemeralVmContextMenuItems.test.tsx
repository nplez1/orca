/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshEphemeralVmRuntimes } from '@/hooks/useEphemeralVmRuntimes'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { EphemeralVmContextMenuItems } from './EphemeralVmContextMenuItems'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type CapturedItem = { children?: unknown; disabled?: boolean; onSelect?: () => void }

const captured = vi.hoisted((): { items: CapturedItem[] } => ({ items: [] }))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: (props: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => {
    captured.items.push(props)
    return <div data-testid="context-menu-item">{props.children}</div>
  }
}))

vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.split(`{{${name}}}`).join(value),
      fallback
    )
}))

const toastLoading = vi.hoisted(() => vi.fn(() => 'toast-1'))
const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { loading: toastLoading, success: toastSuccess, error: toastError }
}))

const WORKSPACE_PATH = '/workspace/repo/.orca-worktrees/fix-login'

const ITEMS = [
  { id: 'launch-vnc', label: 'Launch VNC', command: './launch-vnc.sh' },
  { id: 'launch-rdp', label: 'Launch RDP', command: './launch-rdp.sh' }
]

const runContextMenuItem = vi.fn()

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'team-machine',
    workspaceId: 'repo::ws-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 0,
    updatedAt: 0,
    recipe: { id: 'team-machine', name: 'Team machine', create: 'create.sh' },
    contextMenuItems: ITEMS,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'pair-1',
      projectRoot: '/repo'
    },
    ...overrides
  }
}

/** Points the renderer's runtime cache at a fresh set of records and returns its read mock. */
function installRuntimes(records: EphemeralVmRuntimeRecord[]) {
  const listRuntimes = vi.fn().mockResolvedValue(records)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component under test reads only ephemeralVm.listRuntimes and ephemeralVm.runContextMenuItem.
  window.api = { ephemeralVm: { listRuntimes, runContextMenuItem } } as never
  return listRuntimes
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

async function renderItems(
  workspaceId = 'repo::ws-1',
  disabled = false,
  isMultiContext = false
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  await act(async () => {
    root.render(
      <EphemeralVmContextMenuItems
        model={{
          worktree: { id: workspaceId, path: WORKSPACE_PATH },
          isMultiContext,
          isDeleting: disabled
        }}
      />
    )
  })
  return container
}

/** The item's visible text; each item renders an icon beside its label. */
function itemText(item: CapturedItem | undefined): string {
  const children = item?.children
  return (Array.isArray(children) ? children : [children])
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(async () => {
  await act(async () => {
    mounted.splice(0).forEach((entry) => entry.root.unmount())
  })
  document.body.innerHTML = ''
  captured.items.length = 0
  runContextMenuItem.mockReset()
  toastLoading.mockClear()
  toastSuccess.mockReset()
  toastError.mockReset()
  vi.restoreAllMocks()
})

describe('EphemeralVmContextMenuItems', () => {
  it('renders nothing for a workspace with no ephemeral host', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()

    expect((await renderItems('repo::other')).textContent).toBe('')
    expect(captured.items).toHaveLength(0)
  })

  it('renders nothing when the host declares no items', async () => {
    for (const records of [
      [runtimeRecord({ contextMenuItems: [] })],
      [runtimeRecord({ contextMenuItems: undefined })]
    ]) {
      installRuntimes(records)
      await refreshEphemeralVmRuntimes()

      expect((await renderItems()).textContent).toBe('')
    }
  })

  it('renders nothing for a host that has already been released', async () => {
    installRuntimes([runtimeRecord({ status: 'cleaned', cleanupStatus: 'succeeded' })])
    await refreshEphemeralVmRuntimes()

    expect((await renderItems()).textContent).toBe('')
  })

  it('renders nothing in the multi-workspace menu', async () => {
    // Why: a batch menu acts on a selection, and an item belongs to one workspace's host.
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()

    expect((await renderItems('repo::ws-1', false, true)).textContent).toBe('')
  })

  it('renders nothing for a host whose destroy is already in flight', async () => {
    // Why: main refuses a click during teardown, so offering one could only fail.
    installRuntimes([runtimeRecord({ status: 'cleanup_pending', cleanupStatus: 'running' })])
    await refreshEphemeralVmRuntimes()

    expect((await renderItems()).textContent).toBe('')
  })

  it('offers one entry per declared item, in declaration order', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()

    await renderItems()

    expect(captured.items.map(itemText)).toEqual(['Launch VNC', 'Launch RDP'])
  })

  it('runs only the clicked item, with the workspace path its row carries', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()
    runContextMenuItem.mockResolvedValue({})
    await renderItems()

    await act(async () => {
      captured.items[1]?.onSelect?.()
    })

    expect(runContextMenuItem).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      itemId: 'launch-rdp',
      workspacePath: WORKSPACE_PATH
    })
    expect(toastSuccess).toHaveBeenCalledWith('Ran Launch RDP', { id: 'toast-1' })
  })

  it('shows a running toast that the outcome replaces', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()
    const pending = deferred<unknown>()
    runContextMenuItem.mockReturnValue(pending.promise)
    await renderItems()

    act(() => {
      captured.items[0]?.onSelect?.()
    })
    // Why the loading toast: the menu closes on select, so this is the only visible pending state.
    expect(toastLoading).toHaveBeenCalledWith('Running Launch VNC…')
    expect(toastSuccess).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve({})
      await pending.promise.catch(() => undefined)
    })

    expect(toastSuccess).toHaveBeenCalledWith('Ran Launch VNC', { id: 'toast-1' })
  })

  it('reports the script’s refusal verbatim in place of the running toast', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()
    const pending = deferred<unknown>()
    runContextMenuItem.mockReturnValue(pending.promise)
    await renderItems()

    act(() => {
      captured.items[0]?.onSelect?.()
    })

    await act(async () => {
      // Why the Electron-shaped rejection: main's message arrives wrapped in the channel it came
      // from, and the user must not read that wrapper.
      pending.reject(
        new Error(
          'Error invoking remote method \'ephemeralVm:runContextMenuItem\': Error: Context menu item "Launch VNC" exited with code 4. no node to reach'
        )
      )
      await pending.promise.catch(() => undefined)
    })

    expect(toastError).toHaveBeenCalledWith(
      'Context menu item "Launch VNC" exited with code 4. no node to reach',
      { id: 'toast-1' }
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('falls back to a readable message when the failure carries none', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()
    runContextMenuItem.mockRejectedValue('not an error')
    await renderItems()

    await act(async () => {
      captured.items[0]?.onSelect?.()
    })

    expect(toastError).toHaveBeenCalledWith('Couldn’t run Launch VNC', { id: 'toast-1' })
  })

  it('keeps every entry disabled when the menu itself is disabled', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()

    await renderItems('repo::ws-1', true)

    expect(captured.items.map((item) => item.disabled)).toEqual([true, true])
  })

  it('does not run an item for a workspace whose host it cannot resolve', async () => {
    installRuntimes([runtimeRecord()])
    await refreshEphemeralVmRuntimes()

    await renderItems('repo::other')

    expect(runContextMenuItem).not.toHaveBeenCalled()
  })
})
