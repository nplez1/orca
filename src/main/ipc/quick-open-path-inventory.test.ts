import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import {
  isQuickOpenInventoryOverBudget,
  QUICK_OPEN_INVENTORY_MAX_PATHS,
  QUICK_OPEN_INVENTORY_MAX_PATH_BYTES
} from '../../shared/quick-open-path-inventory-limits'
import {
  clearQuickOpenPathInventories,
  invalidateQuickOpenPathInventory,
  prewarmQuickOpenPathInventory,
  queryQuickOpenPathInventory,
  type QuickOpenPathInventoryMatch
} from './quick-open-path-inventory'

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function asStore(repoPath: string): Store {
  const partial = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: repoPath,
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git'
      }
    ],
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory reads only getRepos/getSettings; mirrors the established filesystem test-store pattern.
  return partial as unknown as Store
}

async function writeRel(root: string, relPath: string, content = 'x'): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

async function waitForMatch(
  root: string,
  store: Store,
  args: { query: string; limit: number; includeIgnoredFiles: boolean },
  timeoutMs = 5_000
): Promise<QuickOpenPathInventoryMatch> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = await queryQuickOpenPathInventory(root, store, args)
    if (match) {
      return match
    }
    if (Date.now() > deadline) {
      throw new Error('inventory did not warm in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('isQuickOpenInventoryOverBudget', () => {
  it('flags counts and retained bytes past the bounds', () => {
    expect(isQuickOpenInventoryOverBudget(10, 100)).toBe(false)
    expect(isQuickOpenInventoryOverBudget(QUICK_OPEN_INVENTORY_MAX_PATHS + 1, 0)).toBe(true)
    expect(isQuickOpenInventoryOverBudget(1, QUICK_OPEN_INVENTORY_MAX_PATH_BYTES + 1)).toBe(true)
  })
})

describe.skipIf(!hasRipgrep())('quick-open path inventory against real ripgrep', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-inventory-'))
    clearQuickOpenPathInventories()
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    tempDir = null
    clearQuickOpenPathInventories()
  })

  it('reports "not warmed" rather than "no matches" before the index exists', async () => {
    const root = tempDir!
    await writeRel(root, 'src/keep-target.ts')

    const result = await queryQuickOpenPathInventory(root, asStore(root), {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: true
    })

    expect(result).toBeNull()
  })

  it('answers from memory with an exact total and the ignored subset', async () => {
    const root = tempDir!
    execFileSync('git', ['init'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await writeRel(root, 'ignored/secret-target.ts')
    await writeRel(root, 'src/keep-target.ts')
    const store = asStore(root)

    prewarmQuickOpenPathInventory(root, store)
    const withIgnored = await waitForMatch(root, store, {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: true
    })
    expect(withIgnored).toEqual({
      paths: ['ignored/secret-target.ts', 'src/keep-target.ts'],
      totalCount: 2,
      truncated: false,
      ignoredPaths: ['ignored/secret-target.ts']
    })

    const withoutIgnored = await queryQuickOpenPathInventory(root, store, {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: false
    })
    expect(withoutIgnored).toEqual({
      paths: ['src/keep-target.ts'],
      totalCount: 1,
      truncated: false,
      ignoredPaths: []
    })
  })

  it('stops claiming a fresh answer once the path set changes', async () => {
    const root = tempDir!
    await writeRel(root, 'src/keep-target.ts')
    const store = asStore(root)

    prewarmQuickOpenPathInventory(root, store)
    const warmed = await waitForMatch(root, store, {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: false
    })
    expect(warmed.totalCount).toBe(1)

    invalidateQuickOpenPathInventory(root)
    const afterInvalidate = await queryQuickOpenPathInventory(root, store, {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: false
    })
    expect(afterInvalidate).toBeNull()

    // The debounced rebuild re-warms the entry for the next query.
    const rewarmed = await waitForMatch(root, store, {
      query: 'target',
      limit: 10,
      includeIgnoredFiles: false
    })
    expect(rewarmed.totalCount).toBe(1)
  })
})
