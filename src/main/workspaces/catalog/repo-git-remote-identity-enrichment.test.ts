import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { GitRemoteIdentity } from '../../../shared/git/remotes/git-remote-identity'
import type { Repo } from '../../../shared/repo-types'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { repoTarget } from '../../persistence/repo-host-target-matcher.test-fixture'
import { type GitRemoteIdentityProbe, probeGitRemoteIdentity } from './repo-git-remote-identity'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type * as DistroGate from '../../wsl/discovery/wsl-background-distro-gate'
import type { WslDistroRunningState } from '../../wsl/discovery/wsl-background-distro-gate'
import '../../git/command-runner/local-git-runtime-route'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({
  probeGitRemoteIdentity: vi.fn()
}))
const distroGate = vi.hoisted((): { state: WslDistroRunningState } => ({ state: 'running' }))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGate>()),
  readWslDistroRunningState: async () => distroGate.state
}))

type RepoIdentityStore = {
  getRepos: () => Repo[]
  getRepo: (id: string) => Repo | undefined
  updateRepo: (
    target: RepoHostTarget,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>
  ) => Repo | null
}

const remoteIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/team/sample-app',
  remoteName: 'origin',
  remoteUrl: 'git@git.company.test:team/sample-app.git',
  remoteKeys: ['git.company.test/team/sample-app']
}

const resolvedProbe: GitRemoteIdentityProbe = { status: 'resolved', identity: remoteIdentity }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/sample-app',
    displayName: 'sample-app',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeStore(...repos: Repo[]): RepoIdentityStore & { updateRepo: ReturnType<typeof vi.fn> } {
  return {
    getRepos: () => repos,
    getRepo: (id) => repos.find((candidate) => candidate.id === id),
    // Match the real store: writes use the row's own host stamp.
    updateRepo: vi.fn((target: RepoHostTarget, updates) => {
      const row = repos.find(
        (candidate) =>
          candidate.id === target.id &&
          getRepoExecutionHostId(candidate) === getRepoExecutionHostId(target)
      )
      if (!row) {
        return null
      }
      Object.assign(row, updates)
      return row
    })
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000

const movedIdentity: GitRemoteIdentity = {
  canonicalKey: 'git.company.test/platform/sample-app',
  remoteName: 'upstream',
  remoteUrl: 'git@git.company.test:platform/sample-app.git',
  remoteKeys: ['git.company.test/platform/sample-app']
}

// fork-comment-ok: fork-only identity field; the why must sit above the code a sync rewrites.
/** A fork keeps its parent on upstream and its own repository on origin. */
const forkIdentity: GitRemoteIdentity = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'upstream',
  remoteUrl: 'https://github.com/stablyai/orca.git',
  remoteKeys: ['github.com/stablyai/orca', 'github.com/nplez1/orca']
}

// fork-comment-ok: fork-only identity field; the why must sit above the code a sync rewrites.
/** The shape an older build persisted: one key, so the fork's own remote is unknown. */
const legacyForkIdentity: GitRemoteIdentity = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'upstream',
  remoteUrl: 'https://github.com/stablyai/orca.git'
}

async function drainEnrichmentSweep(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  }
}

async function sweep(store: RepoIdentityStore): Promise<void> {
  enrichMissingRepoGitRemoteIdentities(store)
  await drainEnrichmentSweep()
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetRepoGitRemoteIdentityEnrichmentForTests()
})

describe('enrichMissingRepoGitRemoteIdentities', () => {
  function drivePathRepoUnderWslRuntime(): { repo: Repo; store: RepoIdentityStore } {
    const repo = makeRepo({ path: String.raw`C:\src\app` })
    const store = {
      ...makeStore(repo),
      getProjects: () => [
        {
          id: 'p1',
          displayName: 'app',
          badgeColor: '',
          sourceRepoIds: [repo.id],
          createdAt: 0,
          updatedAt: 0
        }
      ],
      // The user opted in to WSL hosts (Stage 1), so reads follow the project's runtime.
      getSettings: () => ({
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' },
        experimentalWslHosts: true
      })
    }
    return { repo, store }
  }

  async function sweepOnWindows(store: RepoIdentityStore, gate: string): Promise<void> {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, gate)
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await sweep(store)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      vi.unstubAllEnvs()
      distroGate.state = 'running'
    }
  }

  it("never probes a drive project whose WSL runtime's distro is stopped, so the sweep can't boot it", async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    distroGate.state = 'stopped'
    const { store } = drivePathRepoUnderWslRuntime()
    await sweepOnWindows(store, '1')

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it('never probes a runtime row that names a nested SSH target', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const store = makeStore(
      makeRepo({ connectionId: 'nested-1', executionHostId: 'runtime:env-a' })
    )

    await sweep(store)

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('probes a self-addressed runtime row here and writes it back under its own stamp', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const repo = makeRepo({ executionHostId: 'runtime:env-a' })
    const store = makeStore(repo)

    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledWith(
      '/workspace/sample-app',
      'local',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'runtime:env-a'), {
      gitRemoteIdentity: remoteIdentity
    })
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('settles a repo git answered for but that has no usable remote', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: null
    })
    expect(repo.gitRemoteIdentity).toBeNull()
  })

  it('leaves identity unresolved when the probe could not reach the host', async () => {
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const repo = makeRepo({ connectionId: 'builder' })
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toBeUndefined()
  })

  it('overwrites a resolved identity when the re-probe finds a different canonical key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: movedIdentity
    })
    const repo = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)
    const onChanged = vi.fn()

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    await drainEnrichmentSweep()

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: movedIdentity
    })
    expect(repo.gitRemoteIdentity).toEqual(movedIdentity)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the re-probe returns the same canonical key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: { ...remoteIdentity, remoteUrl: 'https://git.company.test/team/sample-app.git' }
    })
    const store = makeStore(makeRepo({ gitRemoteIdentity: remoteIdentity }))
    const onChanged = vi.fn()

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    enrichMissingRepoGitRemoteIdentities(store, { onChanged })
    await drainEnrichmentSweep()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('keeps the existing identity when a re-probe cannot reach the host', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const repo = makeRepo({ connectionId: 'builder', gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('keeps the existing identity when a re-probe reports no usable remote', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'no-remote' })
    const repo = makeRepo({ gitRemoteIdentity: remoteIdentity })
    const store = makeStore(repo)

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + 1)
    await sweep(store)

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it('upgrades a single-remote record on the first sweep so a fork can link its own repository', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: forkIdentity
    })
    const repo = makeRepo({ gitRemoteIdentity: legacyForkIdentity })
    const store = makeStore(repo)

    // fork-comment-ok: fork-only identity field; the why must sit above the code a sync rewrites.
    // No startup delay: a record from an older build must gain its other remote promptly.
    await sweep(store)

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: forkIdentity
    })
  })

  it('writes a changed key set even when the primary remote stays the same', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    // Why: forking an existing clone of the parent adds origin later — the primary key does not move.
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: forkIdentity
    })
    const repo = makeRepo({ gitRemoteIdentity: legacyForkIdentity })
    const store = makeStore(repo)

    await sweep(store)

    expect(store.updateRepo).toHaveBeenCalledWith(repoTarget('repo-1', 'local'), {
      gitRemoteIdentity: forkIdentity
    })
  })

  it('stops spending refresh slots on a legacy record whose probe keeps failing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'unavailable' })
    const legacy = makeRepo({ id: 'legacy', gitRemoteIdentity: legacyForkIdentity })
    const other = makeRepo({ id: 'other', path: '/workspace/other' })
    const store = makeStore(legacy, other)

    await sweep(store)
    await sweep(store)
    await sweep(store)

    // The failed probe backs the legacy record off instead of claiming a slot on every sweep.
    expect(
      vi.mocked(probeGitRemoteIdentity).mock.calls.filter((call) => call[0] === legacy.path)
    ).toHaveLength(1)
  })
  it('does not re-probe folder workspaces', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue(resolvedProbe)
    const store = makeStore(makeRepo({ kind: 'folder', gitRemoteIdentity: remoteIdentity }))

    await sweep(store)
    vi.setSystemTime(1_000 + REFRESH_STARTUP_DELAY_MS + REFRESH_TTL_MS + 1)
    await sweep(store)

    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  })

  it('does not write stale identity data after the repo path changes', async () => {
    const probe = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(probe.promise)
    const repo = makeRepo()
    const store = makeStore(repo)

    enrichMissingRepoGitRemoteIdentities(store)
    repo.path = '/workspace/renamed-sample-app'
    probe.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(repo.gitRemoteIdentity).toBeUndefined()
  })
})

describe('retiring probes for removed repos', () => {
  function makeMutableStore(live: Repo[]): RepoIdentityStore & {
    updateRepo: ReturnType<typeof vi.fn>
  } {
    return {
      getRepos: () => live,
      getRepo: (id) => live.find((candidate) => candidate.id === id),
      updateRepo: vi.fn(({ id }: RepoHostTarget, updates) => {
        const target = live.find((candidate) => candidate.id === id)
        if (!target) {
          return null
        }
        Object.assign(target, updates)
        return target
      })
    }
  }

  function probeSignal(callIndex: number): AbortSignal {
    const signal = vi.mocked(probeGitRemoteIdentity).mock.calls[callIndex]?.[2]?.signal
    if (!signal) {
      throw new Error(`probe call ${callIndex} was made without an abort signal`)
    }
    return signal
  }

  it('aborts the in-flight probe of a repo that was removed', () => {
    // Do not flush this intentionally wedged promise; the flush would hang.
    vi.mocked(probeGitRemoteIdentity).mockReturnValue(new Promise(() => {}))
    const repo = makeRepo()
    const live: Repo[] = [repo]
    const store = makeMutableStore(live)

    enrichMissingRepoGitRemoteIdentities(store)
    const signal = probeSignal(0)
    expect(signal.aborted).toBe(false)

    live.length = 0
    enrichMissingRepoGitRemoteIdentities(store)

    expect(signal.aborted).toBe(true)
  })

  it('does not let a retired probe write an identity or re-seed a retry deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const wedged = deferred<GitRemoteIdentityProbe>()
    vi.mocked(probeGitRemoteIdentity)
      .mockReturnValueOnce(wedged.promise)
      .mockResolvedValue(resolvedProbe)
    const repo = makeRepo()
    const live: Repo[] = [repo]
    const store = makeMutableStore(live)

    enrichMissingRepoGitRemoteIdentities(store)
    live.length = 0
    enrichMissingRepoGitRemoteIdentities(store)
    wedged.resolve(resolvedProbe)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(store.updateRepo).not.toHaveBeenCalled()

    // A retired probe must not re-seed backoff for this location.
    live.push(repo)
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(probeGitRemoteIdentity).toHaveBeenCalledTimes(2)
  })
})
