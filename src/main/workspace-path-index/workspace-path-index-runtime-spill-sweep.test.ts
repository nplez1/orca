import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import {
  clearLocalWorkspacePathIndex,
  createLocalWorkspacePathIndexService
} from './workspace-path-index-runtime'

const electronMock = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>(() => '') }))

vi.mock('electron', () => ({ app: { getPath: electronMock.getPath } }))

// No live process can hold this pid: above POSIX pid_max, and Windows pids are multiples of 4.
const DEAD_PID = '99999999'

let userDataDirectory: string | null = null

beforeEach(async () => {
  userDataDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-runtime-sweep-'))
  electronMock.getPath.mockReturnValue(userDataDirectory)
})

afterEach(async () => {
  clearLocalWorkspacePathIndex()
  if (userDataDirectory) {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
  userDataDirectory = null
})

function spillRoot(directory: string): string {
  return join(directory, 'workspace-path-index-spill')
}

describe('local workspace path index service startup', () => {
  // Issue #156: a launch that restores every catalog from its checkpoint never begins a build, so
  // the sweep must not depend on one. Creating the service is the first use of the spill root.
  it('sweeps a dead process spill directory before any build or checkpoint restore', async () => {
    const root = spillRoot(userDataDirectory!)
    const currentDirectory = join(root, String(process.pid))
    const deadDirectory = join(root, DEAD_PID)
    await mkdir(currentDirectory, { recursive: true })
    await writeFile(join(currentDirectory, 'restored.wpc'), 'restored')
    await mkdir(deadDirectory, { recursive: true })
    await writeFile(join(deadDirectory, 'abandoned.wpc'), 'abandoned')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creating the service stores the handle and never reads a Store member here.
    createLocalWorkspacePathIndexService({ getSettings: () => ({}) } as unknown as Store)

    await vi.waitFor(async () => {
      expect(await readdir(root)).toEqual([String(process.pid)])
    })
    expect(await readdir(currentDirectory)).toEqual(['restored.wpc'])
  })
})
