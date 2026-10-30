/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshEphemeralVmRuntimes } from '@/hooks/useEphemeralVmRuntimes'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { EphemeralVmExtendLifetimeMenu } from './EphemeralVmExtendLifetimeMenu'
import { formatEphemeralVmDeadline } from './ephemeral-vm-lease-presentation'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type CapturedTrigger = { children?: unknown; disabled?: boolean }
type CapturedItem = { children?: unknown; disabled?: boolean; onSelect?: () => void }

const captured = vi.hoisted((): { triggers: CapturedTrigger[]; items: CapturedItem[] } => ({
  triggers: [],
  items: []
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  DropdownMenuSubContent: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  DropdownMenuSubTrigger: (props: { children?: ReactNode; disabled?: boolean }) => {
    captured.triggers.push(props)
    return <div data-testid="extend-trigger">{props.children}</div>
  },
  DropdownMenuItem: (props: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => {
    captured.items.push(props)
    return <div data-testid="extend-item">{props.children}</div>
  }
}))

vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.split(`{{${name}}}`).join(value),
      fallback
    )
}))

const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

const OLD_RELEASE_AT = '2026-10-13T03:00:00Z'
const NEW_RELEASE_AT = '2026-10-13T07:00:00Z'
const extendLifetime = vi.fn()

function runtimeRecord(
  lease: Pick<EphemeralVmRuntimeRecord, 'extend' | 'extendDurations'> = {},
  releaseAt = OLD_RELEASE_AT
): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'recipe-1',
    workspaceId: 'repo::ws-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 0,
    updatedAt: 0,
    recipe: { id: 'recipe-1', name: 'box', create: 'create.sh' },
    ...lease,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'pair-1',
      projectRoot: '/repo',
      userData: { releaseAt }
    }
  }
}

/** Points the renderer's runtime cache at a fresh set of records and returns its read mock. */
function installRuntimes(records: EphemeralVmRuntimeRecord[]) {
  const listRuntimes = vi.fn().mockResolvedValue(records)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component under test reads only ephemeralVm.listRuntimes and ephemeralVm.extendLifetime.
  window.api = { ephemeralVm: { listRuntimes, extendLifetime } } as never
  return listRuntimes
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

async function renderMenu(workspaceId = 'repo::ws-1'): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  await act(async () => {
    root.render(<EphemeralVmExtendLifetimeMenu workspaceId={workspaceId} disabled={false} />)
  })
  return container
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
  captured.triggers.length = 0
  captured.items.length = 0
  extendLifetime.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  vi.restoreAllMocks()
})

describe('EphemeralVmExtendLifetimeMenu', () => {
  it('renders nothing when the recipe declares no extend durations', async () => {
    const recipesWithoutDurations: Pick<EphemeralVmRuntimeRecord, 'extend' | 'extendDurations'>[] =
      [
        { extend: 'extend.sh' },
        { extendDurations: [] },
        { extend: 'extend.sh', extendDurations: [] }
      ]
    for (const recipe of recipesWithoutDurations) {
      installRuntimes([runtimeRecord(recipe)])
      await refreshEphemeralVmRuntimes()
      const container = await renderMenu()

      expect(container.textContent).toBe('')
      expect(captured.triggers).toHaveLength(0)
    }
  })

  it('renders nothing for a workspace with no ephemeral host', async () => {
    installRuntimes([runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] })])
    await refreshEphemeralVmRuntimes()

    expect((await renderMenu('repo::other')).textContent).toBe('')
  })

  it('renders nothing for a host that has already been released', async () => {
    installRuntimes([
      {
        ...runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] }),
        status: 'cleaned',
        cleanupStatus: 'succeeded'
      }
    ])
    await refreshEphemeralVmRuntimes()

    expect((await renderMenu()).textContent).toBe('')
  })

  it('renders nothing for a host whose destroy is already in flight', async () => {
    // Why: main refuses that extension, so offering it could only produce an action that fails.
    installRuntimes([
      {
        ...runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] }),
        status: 'cleanup_pending',
        cleanupStatus: 'running'
      }
    ])
    await refreshEphemeralVmRuntimes()

    expect((await renderMenu()).textContent).toBe('')
  })

  it('falls back to a readable message when the refusal carries none', async () => {
    installRuntimes([runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] })])
    await refreshEphemeralVmRuntimes()
    extendLifetime.mockRejectedValue('not an error')
    await renderMenu()

    await act(async () => {
      captured.items.at(-1)?.onSelect?.()
    })

    expect(toastError).toHaveBeenCalledWith('Couldn’t extend the lease. Try again.')
  })

  it('offers one entry per declared duration', async () => {
    installRuntimes([runtimeRecord({ extend: 'extend.sh', extendDurations: ['1h', '4h', '1d'] })])
    await refreshEphemeralVmRuntimes()
    const container = await renderMenu()

    expect(container.textContent).toContain('Extend lifetime')
    expect(captured.items.map((item) => item.children)).toEqual([
      'Extend to 1h',
      'Extend to 4h',
      'Extend to 1d'
    ])
  })

  it('still offers the durations after the deadline has passed', async () => {
    installRuntimes([
      runtimeRecord(
        { extend: 'extend.sh', extendDurations: ['4h'] },
        new Date(Date.now() - 60_000).toISOString()
      )
    ])
    await refreshEphemeralVmRuntimes()

    const container = await renderMenu()

    expect(container.textContent).toContain('Extend lifetime')
    expect(captured.items.map((item) => item.children)).toEqual(['Extend to 4h'])
  })

  it('extends the lease, names the new deadline, and refreshes the cached records', async () => {
    const listRuntimes = installRuntimes([
      runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] })
    ])
    await refreshEphemeralVmRuntimes()
    listRuntimes.mockClear()
    // Why the new deadline: the toast must name where the lease moved to, not where it was.
    extendLifetime.mockResolvedValue(
      runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] }, NEW_RELEASE_AT)
    )
    await renderMenu()

    await act(async () => {
      captured.items[0]?.onSelect?.()
    })

    expect(extendLifetime).toHaveBeenCalledWith({ runtimeId: 'runtime-1', lifetime: '4h' })
    const successText = String(toastSuccess.mock.calls[0]?.[0])
    expect(successText).toContain(formatEphemeralVmDeadline(Date.parse(NEW_RELEASE_AT)))
    expect(successText).not.toContain(formatEphemeralVmDeadline(Date.parse(OLD_RELEASE_AT)))
    expect(listRuntimes).toHaveBeenCalledTimes(1)
  })

  it('reports the provider message verbatim and re-enables the entry after a refusal', async () => {
    installRuntimes([runtimeRecord({ extend: 'extend.sh', extendDurations: ['4h'] })])
    await refreshEphemeralVmRuntimes()
    const pending = deferred<EphemeralVmRuntimeRecord>()
    extendLifetime.mockReturnValue(pending.promise)
    await renderMenu()

    act(() => {
      captured.items[0]?.onSelect?.()
    })
    expect(captured.triggers.at(-1)?.disabled).toBe(true)
    expect(captured.items.at(-1)?.children).toBe('Extending…')

    await act(async () => {
      // Why the Electron-shaped rejection: main's message arrives wrapped in the channel it came
      // from, and the provider's reason is the part the user needs.
      pending.reject(
        new Error(
          "Error invoking remote method 'ephemeralVm:extendLifetime': Error: quota exceeded for this region"
        )
      )
      await pending.promise.catch(() => undefined)
    })

    expect(toastError).toHaveBeenCalledWith('quota exceeded for this region')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(captured.items.at(-1)?.children).toBe('Extend to 4h')
    expect(captured.items.at(-1)?.disabled).toBe(false)
  })
})
