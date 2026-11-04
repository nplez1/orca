import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LeftoverCheckoutFolderError } from '../../shared/worktree/removal'

const removeHostCheckout = vi.hoisted(() => vi.fn())
const listWorktreesStrict = vi.hoisted(() => vi.fn())
const gitExecFileAsync = vi.hoisted(() => vi.fn())
const unlink = vi.hoisted(() => vi.fn())

vi.mock('../host-tree-removal', () => ({ removeHostCheckout }))
vi.mock('./worktree-listing', () => ({ listWorktreesStrict }))
vi.mock('./runner', () => ({ gitExecFileAsync }))
vi.mock('../asar-transparent-fs', () => ({ unlink }))

const { removeWindowsCheckout } = await import('./windows-worktree-removal')

const repo = 'C:/code/app'
const root = 'C:/code/app-build'
const leftover = { path: root, blockingFile: `${root}/held.dll` }

beforeEach(() => {
  vi.clearAllMocks()
  removeHostCheckout.mockRejectedValue(new LeftoverCheckoutFolderError(leftover))
  gitExecFileAsync.mockResolvedValue({ stdout: '' })
  unlink.mockResolvedValue(undefined)
})

describe('removeWindowsCheckout with a folder the OS will not empty', () => {
  it('releases the registration and reports the folder instead of failing the removal', async () => {
    listWorktreesStrict.mockResolvedValue([])

    await expect(removeWindowsCheckout(repo, root, true, {})).resolves.toEqual(leftover)

    expect(gitExecFileAsync).toHaveBeenCalledWith(
      expect.arrayContaining(['worktree', 'remove', '--force', '--', root]),
      expect.objectContaining({ admissionExempt: true })
    )
    // A marker pointing at a removed administrative entry must not read as a worktree.
    expect(unlink).toHaveBeenCalledWith(`${root}/.git`)
  })

  it('still fails when Git kept the registration, naming the blocking file', async () => {
    listWorktreesStrict.mockResolvedValue([{ path: root, branch: 'refs/heads/feat', head: 'abc' }])

    await expect(removeWindowsCheckout(repo, root, true, {})).rejects.toThrow(
      `${root}/held.dll could not be deleted, and Git still registers the checkout at ${root}. Close any program using it and delete again.`
    )
    expect(unlink).not.toHaveBeenCalled()
  })

  it('passes any other refusal through untouched', async () => {
    const refusal = new Error('Worktree is locked by Git.')
    removeHostCheckout.mockRejectedValue(refusal)

    await expect(removeWindowsCheckout(repo, root, true, {})).rejects.toBe(refusal)
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })
})
