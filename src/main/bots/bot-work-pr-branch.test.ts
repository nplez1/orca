import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ gitExec: vi.fn(), ghExec: vi.fn(), resolveRepo: vi.fn() }))

vi.mock('../git/command-runner/git-exec-file', () => ({
  gitExecFileAsync: mocks.gitExec,
  extractExecError: () => ({ stdout: '', stderr: '' })
}))
vi.mock('../git/command-runner/hosted-cli/gh-exec-file', () => ({ ghExecFileAsync: mocks.ghExec }))
vi.mock('../github/repositories/github-api-repository', () => ({
  resolveGitHubRepoExecution: mocks.resolveRepo
}))

import {
  botWorkHasPrBranch,
  workerGitHubRepo,
  type BotBranchWorkspace,
  type BotWorkRows
} from './bot-work-pr-branch'
import { getGitHubTrackedRepository } from './bot-work-pr-github-repo'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkRow } from './bot-work-store'
import type { BotWorkWorker } from './bot-work-types'

const CHECKOUT = '/checkout'
const REPO = { repoId: 101, repoFullName: 'org/repo' }
const opened = (headRef: string, number = 7) => ({ ...REPO, number, head: REPO, headRef })
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module only tells rows apart.
const ROW = { rowId: 'row-1', generation: 1 } as BotWorkRow
const workspace = (
  branch: string,
  repo: { id: number | null; fullName: string } | null = { id: REPO.repoId, fullName: 'Org/Repo' }
): BotBranchWorkspace => ({ branch: `refs/heads/${branch}`, githubRepo: async () => repo })
const work = (rows: BotWorkRow[], workspaces: (BotBranchWorkspace | null)[]): BotWorkRows => ({
  rows: async () => rows,
  workspace: async (checked) => workspaces[rows.indexOf(checked)] ?? null
})
const worker = (overrides: Partial<BotWorkWorker> = {}): BotWorkWorker =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a double carries only the fields this module reads.
  ({ dispatchId: 'd1', host: 'local', worktreeId: 'repo-1::/wt', ...overrides }) as BotWorkWorker
const runtime = (): BotWorkRuntime =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a double stands in for the runtime the module reads through.
  ({
    linkStore: () => ({ getRepos: () => [{ id: 'repo-1', path: CHECKOUT }] }),
    getOrchestrationDb: () => ({ getFederatedDispatch: () => undefined })
  }) as unknown as BotWorkRuntime

beforeEach(() => {
  mocks.gitExec.mockReset().mockResolvedValue({ stdout: 'origin\n', stderr: '' })
  mocks.ghExec.mockReset().mockResolvedValue({ stdout: '101\n', stderr: '' })
  mocks.resolveRepo
    .mockReset()
    .mockResolvedValue({ ownerRepo: { owner: 'acme', repo: 'tracked' }, ghOptions: {} })
})

describe("a pull request is a bot's own work by its head branch", () => {
  it("knows a worker's branch in the head's repository, and no other branch or repository", async () => {
    const fixing = work([ROW], [workspace('fix-login')])
    expect(await botWorkHasPrBranch(fixing, opened('fix-login'))).toBe(true)
    expect(await botWorkHasPrBranch(fixing, opened('carol/by-hand', 9))).toBe(false)
    // The same branch name in a fork of it is another repository's.
    const fork = { ...opened('fix-login'), head: { repoId: 999, repoFullName: '' } }
    expect(await botWorkHasPrBranch(fixing, fork)).toBe(false)
    expect(await botWorkHasPrBranch(work([ROW], [null]), opened('fix-login'))).toBe(false)
    expect(await botWorkHasPrBranch(work([], []), opened('fix-login'))).toBe(false)
  })

  it("matches a repository known by name only by that name, and takes an unknown one as the bot's", async () => {
    const byName = (fullName: string) =>
      work([ROW], [workspace('fix-login', { id: null, fullName })])
    expect(await botWorkHasPrBranch(byName('Org/Repo'), opened('fix-login'))).toBe(true)
    expect(await botWorkHasPrBranch(byName('org/other'), opened('fix-login'))).toBe(false)
    const unknown = work([ROW], [workspace('fix-login', null)])
    expect(await botWorkHasPrBranch(unknown, opened('fix-login'))).toBe(true)
  })
})

describe('the GitHub repository a worker is on', () => {
  it("reads a local worker's branch repository, and names none for a worker it cannot place", async () => {
    mocks.resolveRepo.mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'web' },
      ghOptions: {}
    })
    expect(await workerGitHubRepo(runtime(), worker(), 'refs/heads/fix-login')).toEqual({
      id: 101,
      fullName: 'acme/web'
    })
    expect(mocks.gitExec).toHaveBeenCalledWith(['config', '--get', 'branch.fix-login.remote'], {
      cwd: CHECKOUT
    })
    mocks.gitExec.mockClear()
    expect(await workerGitHubRepo(runtime(), worker({ worktreeId: null }), 'fix-login')).toBeNull()
    expect(await workerGitHubRepo(runtime(), worker({ host: 'env-2' }), 'fix-login')).toBeNull()
    expect(mocks.gitExec).not.toHaveBeenCalled()
  })
})

describe('the GitHub repository a branch tracks', () => {
  it("reads the branch's remote, and the id GitHub gives the repository", async () => {
    mocks.resolveRepo.mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'fresh' },
      ghOptions: {}
    })
    mocks.ghExec.mockResolvedValue({ stdout: '303\n', stderr: '' })
    expect(await getGitHubTrackedRepository(CHECKOUT, 'fix-login')).toEqual({
      id: 303,
      fullName: 'acme/fresh'
    })
    expect(mocks.gitExec).toHaveBeenCalledWith(['config', '--get', 'branch.fix-login.remote'], {
      cwd: CHECKOUT
    })
    expect(mocks.ghExec).toHaveBeenCalledWith(
      ['api', 'repos/acme/fresh', '--jq', '.id'],
      expect.objectContaining({ timeout: 10_000 })
    )
  })

  it('names no repository when the checkout names none, and reads a paired host there', async () => {
    mocks.resolveRepo.mockResolvedValue({ ownerRepo: null, ghOptions: {} })
    expect(await getGitHubTrackedRepository(CHECKOUT, 'fix-login')).toBeNull()
    mocks.gitExec.mockClear()
    expect(await getGitHubTrackedRepository(CHECKOUT, 'fix-login', 'host-1')).toBeNull()
    expect(mocks.gitExec).not.toHaveBeenCalled()
    expect(mocks.resolveRepo).toHaveBeenLastCalledWith(CHECKOUT, undefined, 'host-1')
  })

  it('keeps the name when GitHub does not answer, and asks it once it does', async () => {
    mocks.resolveRepo.mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'quiet' },
      ghOptions: {}
    })
    mocks.ghExec
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ stdout: '7\n', stderr: '' })
    const read = () => getGitHubTrackedRepository(CHECKOUT, 'fix-login')
    expect(await read()).toEqual({ id: null, fullName: 'acme/quiet' })
    expect(await read()).toEqual({ id: 7, fullName: 'acme/quiet' })
    expect(mocks.ghExec).toHaveBeenCalledTimes(2)
  })
})
