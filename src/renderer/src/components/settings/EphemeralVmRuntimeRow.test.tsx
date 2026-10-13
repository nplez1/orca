// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { EphemeralVmRuntimeRow } from './EphemeralVmRuntimeRow'

const roots: Root[] = []

function makeRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix Login Race',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'orca://pair?code=test',
      projectRoot: '/workspace/repo'
    },
    ...overrides
  }
}

function withLease(
  runtime: EphemeralVmRuntimeRecord,
  releaseAtMs: number,
  provider?: string
): EphemeralVmRuntimeRecord {
  return {
    ...runtime,
    recipeResult: {
      ...runtime.recipeResult,
      userData: {
        releaseAt: new Date(releaseAtMs).toISOString(),
        ...(provider ? { provider } : {})
      }
    }
  }
}

function renderRow(
  runtime: EphemeralVmRuntimeRecord,
  props: { extendDurations?: string[]; extendingLifetime?: string | null } = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <EphemeralVmRuntimeRow
        runtime={runtime}
        statusLabel="Running"
        cleanupFailed={false}
        cleanupRunning={false}
        isStopping={false}
        disabled={false}
        extendDurations={props.extendDurations ?? []}
        extendingLifetime={props.extendingLifetime ?? null}
        onCleanup={vi.fn()}
        onStopCleanup={vi.fn()}
        onCopyCleanupCommand={vi.fn()}
        onExtendLifetime={vi.fn()}
      />
    )
  })
  return container
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  roots.splice(0).forEach((root) => {
    act(() => root.unmount())
  })
  document.body.replaceChildren()
})

describe('EphemeralVmRuntimeRow lease', () => {
  it('names the provider deadline and counts down to it', () => {
    const container = renderRow(withLease(makeRuntime(), Date.now() + 3 * 60 * 60_000, 'fly'))

    expect(container.textContent).toContain('Provider deadline')
    expect(container.textContent).toContain('Provider: fly')
    expect(container.textContent).toMatch(/\d+:\d{2}(:\d{2})? left/)
  })

  it('replaces the countdown with the expired warning once the deadline passes', () => {
    const container = renderRow(withLease(makeRuntime(), Date.now() - 60_000, 'fly'))

    expect(container.textContent).toContain('Lease expired')
    expect(container.textContent).toContain(
      'The provider can remove this host at any time, including while Orca is offline.'
    )
    expect(container.textContent).not.toContain('left')
  })

  it('says nothing about a lease when the recipe published no deadline', () => {
    const container = renderRow(makeRuntime())

    expect(container.textContent).not.toContain('Provider deadline')
    expect(container.textContent).not.toContain('Lease expired')
  })

  it('keeps the retained cleanup error readable on a reclaimed host', () => {
    const container = renderRow(
      makeRuntime({
        cleanupStatus: 'failed',
        cleanupLastError: 'provider delete failed: host already deallocated'
      })
    )

    expect(container.textContent).toContain('provider delete failed: host already deallocated')
  })

  it('offers Extend lifetime only for the durations the recipe declares', () => {
    const withoutDurations = renderRow(makeRuntime())
    expect(withoutDurations.textContent).not.toContain('Extend lifetime')

    const withDurations = renderRow(makeRuntime(), { extendDurations: ['4h', '1d'] })
    expect(withDurations.textContent).toContain('Extend lifetime')

    const extending = renderRow(makeRuntime(), {
      extendDurations: ['4h'],
      extendingLifetime: '4h'
    })
    expect(extending.textContent).toContain('Extending…')
    expect(extending.textContent).not.toContain('Extend lifetime')
  })
})
