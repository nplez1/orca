import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../../shared/workspace-setup/orca-yaml-hook-types'
import { ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

const hooksCheckMock = vi.fn()
const runtimeEnvironmentCallMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()

function installHooksApiMock(): void {
  vi.stubGlobal('window', {
    api: {
      hooks: {
        check: hooksCheckMock,
        readIssueCommand: vi.fn()
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCallMock
      }
    }
  })
}

type PendingPrompt = {
  modal: string
  data: Record<string, unknown>
  resolve: (decision: 'run' | 'skip') => void
}

function createTestState(): { state: AppState; pending: PendingPrompt[] } {
  const pending: PendingPrompt[] = []
  const trust: PersistedTrustedOrcaHooks = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test store carries only the slices this hook reads.
  const state = {
    trustedOrcaHooks: trust,
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    projectGroups: [],
    openModal: (modal: string, data: Record<string, unknown>) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub modal records this exact callback signature.
      pending.push({ modal, data, resolve: data.onResolve as (d: 'run' | 'skip') => void })
    },
    closeModal: () => undefined
  } as unknown as AppState
  return { state, pending }
}

describe('ensureHooksConfirmed', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    runtimeEnvironmentCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        return (
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
        )
      }
    )
    clearRuntimeCompatibilityCacheForTests()
    installHooksApiMock()
  })

  it('shows the recipe extend hook and its lifetimes in the trust prompt', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: {
        environmentRecipes: [
          {
            id: 'cloud-sandbox',
            name: 'Cloud Sandbox',
            create: './scripts/start-vm.sh',
            extend: './scripts/extend-vm.sh',
            extendDurations: ['1h', '4h']
          }
        ]
      },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'vmRecipe')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toContain('extend: ./scripts/extend-vm.sh')
    expect(pending[0].data.scriptContent).toContain('extendDurations: 1h, 4h')

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('shows each recipe context menu item command in the trust prompt', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: {
        environmentRecipes: [
          {
            id: 'cloud-sandbox',
            name: 'Cloud Sandbox',
            create: './scripts/start-vm.sh',
            contextMenuItems: [
              { id: 'launch-vnc', label: 'Launch VNC', command: './scripts/launch-vnc.sh' },
              { id: 'launch-rdp', label: 'Launch RDP', command: './scripts/launch-rdp.sh' }
            ]
          }
        ]
      },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'vmRecipe')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // Why the command itself: this is the only place the user can see what a click will run, and a
    // recipe that already approved a `create` must not gain one without the prompt changing.
    const content = String(pending[0].data.scriptContent)
    expect(content).toContain('contextMenuItems.launch-vnc (Launch VNC): ./scripts/launch-vnc.sh')
    expect(content).toContain('contextMenuItems.launch-rdp (Launch RDP): ./scripts/launch-rdp.sh')
    const withoutItems = await hashOrcaHookScript(content.replace(/\ncontextMenuItems\..*$/gm, ''))
    expect(pending[0].data.contentHash).not.toBe(withoutItems)

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })

  it('keeps a recipe that declares no actions on its existing trust content', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: {
        environmentRecipes: [
          { id: 'cloud-sandbox', name: 'Cloud Sandbox', create: './scripts/start-vm.sh' }
        ]
      },
      mayNeedUpdate: false
    })

    const promise = ensureHooksConfirmed(state, 'repo-1', 'vmRecipe')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // Why exact: anything added for a recipe with no extend hook and no items would invalidate every
    // approval already stored for it.
    const expectedContent =
      '# environmentRecipes.cloud-sandbox\nname: Cloud Sandbox\ncreate: ./scripts/start-vm.sh'
    expect(pending[0].data.scriptContent).toBe(expectedContent)
    expect(pending[0].data.contentHash).toBe(await hashOrcaHookScript(expectedContent))

    pending[0].resolve('run')
    await expect(promise).resolves.toBe('run')
  })
})
