import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'

/** This suite is the only one that needs a real ripgrep binary; skip it where there isn't one. */
function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Enough files that an unscoped listing stops at its cap before the walk reaches a deep match. */
const FILE_COUNT_BEYOND_LISTING_CAP = 20_002

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the search reads only getRepos/getSettings; this mirrors the established filesystem test-store pattern.
  return partial as unknown as Store
}

async function writeRel(root: string, relPath: string, content = 'x'): Promise<void> {
  const absPath = join(root, ...relPath.split('/'))
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content)
}

describe.skipIf(!hasRipgrep())('searchQuickOpenFilePaths against real ripgrep', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-path-search-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    tempDir = null
  })

  it('finds a deep name-filter match beyond the unscoped listing cap', async () => {
    const root = tempDir!
    await mkdir(join(root, 'bulk'), { recursive: true })
    for (let start = 0; start < FILE_COUNT_BEYOND_LISTING_CAP; start += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, offset) =>
          writeFile(join(root, 'bulk', `f-${start + offset}.ts`), '')
        )
      )
    }
    await writeRel(root, 'src/a/b/drover.eve_schema')

    const result = await searchQuickOpenFilePaths(root, asStore(root), {
      query: 'drover.eve',
      limit: 5_000,
      mode: 'name-filter'
    })

    expect(result).toEqual({
      paths: ['src/a/b/drover.eve_schema'],
      totalCount: 1,
      truncated: false
    })
  }, 60_000)

  it('counts every real match while returning a bounded sorted page', async () => {
    const root = tempDir!
    for (const name of ['target-a.ts', 'target-b.ts', 'target-c.ts', 'other.ts']) {
      await writeRel(root, `src/${name}`)
    }

    const result = await searchQuickOpenFilePaths(root, asStore(root), {
      query: 'target',
      limit: 2,
      mode: 'name-filter'
    })

    expect(result.paths).toEqual(['src/target-a.ts', 'src/target-b.ts'])
    expect(result.totalCount).toBe(3)
    expect(result.truncated).toBe(true)
  })

  it('keeps the default fuzzy mode working against real ripgrep', async () => {
    const root = tempDir!
    await writeRel(root, 'src/a/b/drover.eve_schema')
    await writeRel(root, 'src/unrelated.ts')

    const result = await searchQuickOpenFilePaths(root, asStore(root), {
      query: 'drover',
      limit: 32
    })

    expect(result).toEqual({
      paths: ['src/a/b/drover.eve_schema'],
      totalCount: 1,
      truncated: false
    })
  })
})
