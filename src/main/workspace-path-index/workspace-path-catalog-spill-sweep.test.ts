import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanStaleWorkspacePathCatalogSpillDirectories,
  scheduleWorkspacePathCatalogSpillSweep
} from './workspace-path-catalog-spill-sweep'

// Above any default pid_max, so an ambient process can never make a dead-PID case flaky.
const DEAD_PID = '99999999'
const RECYCLED_PID = '5150'
const OLD_ENOUGH = new Date('2026-10-15T09:41:00.000Z')

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

async function spillRoot(label: string): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), `orca-path-spill-sweep-${label}-`))
  return temporaryDirectory
}

async function writeSpillFile(directory: string, name: string, age: Date | null): Promise<void> {
  await mkdir(directory, { recursive: true })
  const file = join(directory, name)
  await writeFile(file, name)
  if (age) {
    await utimes(file, age, age)
    await utimes(directory, age, age)
  }
}

function currentProcessDirectory(root: string): string {
  return join(root, String(process.pid))
}

describe('workspace path catalog spill root sweep', () => {
  it('removes a dead process directory without touching the current process', async () => {
    const root = await spillRoot('dead')
    const currentDirectory = currentProcessDirectory(root)
    await writeSpillFile(currentDirectory, 'live.wpc', null)
    await writeSpillFile(join(root, DEAD_PID), 'stale.wpc', null)
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory, {
      isProcessAlive: () => false
    })
    expect(await readdir(root)).toEqual([String(process.pid)])
    expect(await readdir(currentDirectory)).toEqual(['live.wpc'])
  })

  it('removes a recycled PID directory whose newest entry predates this process', async () => {
    const root = await spillRoot('recycled')
    const currentDirectory = currentProcessDirectory(root)
    await mkdir(currentDirectory, { recursive: true })
    await writeSpillFile(join(root, RECYCLED_PID), 'abandoned.wpc', OLD_ENOUGH)
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory, {
      isProcessAlive: () => true
    })
    expect(await readdir(root)).toEqual([String(process.pid)])
  })

  it('keeps a live owner that is still writing to its directory', async () => {
    const root = await spillRoot('live')
    const currentDirectory = currentProcessDirectory(root)
    const liveOwner = join(root, RECYCLED_PID)
    await mkdir(currentDirectory, { recursive: true })
    await writeSpillFile(liveOwner, 'in-progress.wpc', null)
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory, {
      isProcessAlive: () => true
    })
    expect((await readdir(root)).sort()).toEqual([String(process.pid), RECYCLED_PID].sort())
    expect(await readdir(liveOwner)).toEqual(['in-progress.wpc'])
  })

  it('keeps the current process directory even when its entries are old', async () => {
    const root = await spillRoot('current')
    const currentDirectory = currentProcessDirectory(root)
    await writeSpillFile(currentDirectory, 'restored.wpc', OLD_ENOUGH)
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory, {
      isProcessAlive: () => true
    })
    expect(await readdir(root)).toEqual([String(process.pid)])
    expect(await readdir(currentDirectory)).toEqual(['restored.wpc'])
  })

  it('ignores non-numeric directories and root-level files', async () => {
    const root = await spillRoot('layout')
    const currentDirectory = currentProcessDirectory(root)
    await mkdir(currentDirectory, { recursive: true })
    await mkdir(join(root, 'scratch'), { recursive: true })
    await writeFile(join(root, 'stray.wpc'), 'stray')
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory)
    expect((await readdir(root)).sort()).toEqual(
      ['scratch', 'stray.wpc', String(process.pid)].sort()
    )
  })

  it('sweeps once per spill root per process', async () => {
    const root = await spillRoot('once')
    const currentDirectory = currentProcessDirectory(root)
    await mkdir(currentDirectory, { recursive: true })
    await scheduleWorkspacePathCatalogSpillSweep(currentDirectory)
    const leftOver = join(root, DEAD_PID)
    await writeSpillFile(leftOver, 'created-after-the-sweep.wpc', null)
    await scheduleWorkspacePathCatalogSpillSweep(currentDirectory)
    expect(await readdir(leftOver)).toEqual(['created-after-the-sweep.wpc'])
  })

  it('resolves instead of rejecting when the spill root cannot be swept, then retries', async () => {
    const root = await spillRoot('blocked')
    const processDirectory = join(root, 'not-a-directory', String(process.pid))
    await writeFile(join(root, 'not-a-directory'), 'file')
    await expect(scheduleWorkspacePathCatalogSpillSweep(processDirectory)).resolves.toBeUndefined()

    await rm(join(root, 'not-a-directory'))
    const abandoned = join(root, 'not-a-directory', DEAD_PID)
    await writeSpillFile(abandoned, 'abandoned.wpc', null)
    await scheduleWorkspacePathCatalogSpillSweep(processDirectory)
    expect(await readdir(join(root, 'not-a-directory'))).toEqual([])
  })
})
