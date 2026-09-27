import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createVisibleFileExplorerRowProjection,
  getFileExplorerIgnoredQueryRelativePaths
} from './useFileExplorerVisibleRowProjection'
import { getEffectiveFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'
import {
  createNameFilteredFileExplorerProjection,
  createNameFilteredFileExplorerProjectionInChunks,
  FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES,
  getFileExplorerNameFilterEmptyMessageKind,
  getFileExplorerNameFilterExpandedPaths,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  getFileExplorerNameFilterProjectionEstimatedBytes,
  getFileExplorerNameFilterTokens,
  MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES,
  shouldBuildNameFilterProjectionInChunks
} from './file-explorer-name-filter-projection'
import type {
  WorkspacePathSearchResponse,
  WorkspacePathSearchRowClassificationFlags
} from '../../../../shared/workspace-path-search-contract'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

function row(relativePath: string, isDirectory = false, depth?: number): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: depth ?? relativePath.split('/').length - 1
  }
}

function cache(childrenByPath: Record<string, TreeNode[]>): Record<string, DirCache> {
  const dirCache: Record<string, DirCache> = {}
  for (const [path, children] of Object.entries(childrenByPath)) {
    dirCache[path] = { children }
  }
  return dirCache
}

function input(
  childrenByPath: Record<string, TreeNode[]>,
  expandedPaths: string[] = []
): Parameters<typeof createVisibleFileExplorerRowProjection>[0] {
  return {
    dirCache: cache(childrenByPath),
    expanded: new Set(expandedPaths),
    worktreePath: '/repo'
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

function makeStructuredPathPage(paths: string[], query = 'file'): WorkspacePathSearchResponse {
  const scope = {
    pathSet: 'all' as const,
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
  const flags: WorkspacePathSearchRowClassificationFlags[] = paths.map(() => 0)
  return {
    requestIdentity: {
      query,
      consumer: { consumerId: 'consumer-1', sequence: 1 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'host-1' },
        authorizedCanonicalRoot: '/repo'
      },
      generationId: null,
      mode: 'name-filter',
      scope,
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: 1_000_000 }
    },
    generationId: 'generation-1',
    scopeFingerprint: JSON.stringify(scope),
    scopeRuleVersion: 'live-path-search-v1',
    rows: paths.map((relativePath) => ({ relativePath })),
    rowClassificationFlags: flags,
    retainedCount: paths.length,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: paths.length, provenance: 'exact-snapshot' }
  }
}

describe('file explorer visible row projection', () => {
  it('only reports no match for complete no-known-gap exact snapshot states', () => {
    const complete = makeStructuredPathPage([])
    const partial: WorkspacePathSearchResponse = {
      ...complete,
      state: {
        coverage: 'partial',
        freshness: 'unknown',
        countProvenance: 'legacy',
        searchComplete: false
      },
      count: { value: null, provenance: 'legacy' }
    }

    expect(
      getFileExplorerNameFilterEmptyMessageKind({
        hasNameFilter: true,
        hasLoadError: false,
        truncated: false,
        workspacePathSearch: complete
      })
    ).toBe('no-match')
    expect(
      getFileExplorerNameFilterEmptyMessageKind({
        hasNameFilter: true,
        hasLoadError: false,
        truncated: false,
        workspacePathSearch: partial
      })
    ).toBe('partial-scan')
  })

  it('projects structured host pages with the same tree order as the legacy projection', () => {
    const paths = ['src/FileExplorer.tsx', 'docs/FileExplorer.tsx']
    const options = {
      ignoredSet: new Set<string>(),
      showDotfiles: true,
      showGitIgnoredFiles: true,
      worktreePath: '/repo'
    }
    const structuredProjection = createNameFilteredFileExplorerProjection({
      ...options,
      nameFilter: {
        query: 'file',
        relativePaths: paths,
        workspacePathSearch: makeStructuredPathPage(paths)
      }
    })
    const legacyProjection = createNameFilteredFileExplorerProjection({
      ...options,
      nameFilter: { query: 'file', relativePaths: paths }
    })

    expect(structuredProjection.getVisibleSlice(0, 10)).toEqual(
      legacyProjection.getVisibleSlice(0, 10)
    )
  })

  it('trusts host matching but still rejects paths outside the workspace boundary', () => {
    const paths = [
      '../outside.ts',
      '/absolute/target.ts',
      '\\\\absolute\\\\target.ts',
      'trailing/',
      'src/not-matching-this-query.ts'
    ]
    const source = makeStructuredPathPage(paths)
    const projection = createNameFilteredFileExplorerProjection({
      ignoredSet: new Set(),
      nameFilter: {
        query: 'file',
        relativePaths: paths,
        workspacePathSearch: source
      },
      showDotfiles: true,
      showGitIgnoredFiles: true,
      worktreePath: '/repo'
    })

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/not-matching-this-query.ts'
    ])
  })

  it('keeps dotfiles and ignored files visible when toggles are on', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src/index.ts'), row('.env'), row('dist/bundle.js')]
      }),
      {
        ignoredSet: new Set(['dist']),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleCount()).toBe(3)
    expect(projection.getVisibleSlice(0, 2).map((entry) => entry.relativePath)).toEqual([
      'src/index.ts',
      '.env',
      'dist/bundle.js'
    ])
  })

  it('filters dotfiles before building the visible path map', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [
          row('src/index.ts'),
          row('.env'),
          row('.config/settings.json'),
          row('src/.generated/output.ts')
        ]
      }),
      {
        ignoredSet: new Set(),
        showDotfiles: false,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src/index.ts'
    ])
    expect(projection.hasPath('/repo/.env')).toBe(false)
  })

  it('filters ignored files and descendants when git-ignored files are hidden', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('dist', true, 0), row('dist2', true, 0), row('.env')],
          '/repo/src': [row('src/index.ts', false, 1)],
          '/repo/dist': [row('dist/bundle.js', false, 1)],
          '/repo/dist2': [row('dist2/bundle.js', false, 1)]
        },
        ['/repo/src', '/repo/dist', '/repo/dist2']
      ),
      {
        ignoredSet: new Set(['dist', '.env']),
        showDotfiles: true,
        showGitIgnoredFiles: false
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/index.ts',
      'dist2',
      'dist2/bundle.js'
    ])
  })

  it('walks expanded directories and skips cached descendants of collapsed directories', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('collapsed', true, 0), row('root.ts', false, 0)],
          '/repo/src': [row('src/index.ts', false, 1)],
          '/repo/collapsed': [row('collapsed/hidden.ts', false, 1)]
        },
        ['/repo/src']
      ),
      {
        ignoredSet: new Set(),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/index.ts',
      'collapsed',
      'root.ts'
    ])
    expect(projection.hasPath('/repo/collapsed/hidden.ts')).toBe(false)
  })

  it('filters recursive file-list paths even when folders are not loaded in the tree cache', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src', true, 0), row('package.json', false, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'FileExplorer',
          relativePaths: [
            'src/components/right-sidebar/FileExplorer.tsx',
            'src/components/right-sidebar/Search.tsx'
          ]
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/components',
      'src/components/right-sidebar',
      'src/components/right-sidebar/FileExplorer.tsx'
    ])
  })

  it('hides descendants under collapsed folders while a file-name filter is active', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('docs', true, 0), row('src', true, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'ts',
          relativePaths: ['docs/guide.ts', 'src/components/FileExplorer.tsx', 'src/index.ts']
        },
        nameFilterCollapsedPaths: new Set(['/repo/src']),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'docs',
      'docs/guide.ts',
      'src'
    ])
    expect([...getFileExplorerNameFilterExpandedPaths(projection, 'ts')]).toEqual(['/repo/docs'])
  })

  it('does not fall back to the partial cached tree while recursive file filtering is loading', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        ['/repo/src']
      ),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'FileExplorer',
          relativePaths: null
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleCount()).toBe(0)
  })

  it('marks ancestor folders as expanded only while a file-name filter is active', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('package.json', false, 0)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        []
      ),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'file',
          relativePaths: ['src/FileExplorer.tsx']
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect([...getFileExplorerNameFilterExpandedPaths(projection, 'file')]).toEqual(['/repo/src'])
    expect([...getFileExplorerNameFilterExpandedPaths(projection, '')]).toEqual([])
  })

  it('applies dotfile and ignored visibility to file-name filter results', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('.config', true, 0), row('dist', true, 0), row('src', true, 0)],
          '/repo/.config': [row('.config/FileExplorer.tsx', false, 1)],
          '/repo/dist': [row('dist/FileExplorer.js', false, 1)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        []
      ),
      {
        ignoredSet: new Set(['dist']),
        nameFilter: {
          query: 'file',
          relativePaths: [
            '.config/FileExplorer.tsx',
            'dist/FileExplorer.js',
            'src/FileExplorer.tsx'
          ]
        },
        showDotfiles: false,
        showGitIgnoredFiles: false
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/FileExplorer.tsx'
    ])
  })

  it('rejects oversized file-name filter queries before scanning recursive paths', () => {
    const oversizedQuery = 'secret-file-filter'.repeat(FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES)
    const nameFilter = {
      query: oversizedQuery,
      relativePaths: ['src/FileExplorer.tsx', 'docs/secret-file-filter.md']
    }

    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src', true, 0), row('docs', true, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter,
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(getFileExplorerNameFilterTokens(oversizedQuery)).toEqual([])
    expect(getFileExplorerNameFilterIgnoredQueryRelativePaths(nameFilter, true)).toEqual([])
    expect(projection.getVisibleCount()).toBe(0)
    expect([...getFileExplorerNameFilterExpandedPaths(projection, oversizedQuery)]).toEqual([])
  })

  it('tokenizes accepted pasted file-name filters without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const query = ['  FileExplorer', String.fromCharCode(160), '\nStatus  '].join('')

    expect(getFileExplorerNameFilterTokens(query)).toEqual(['fileexplorer', 'status'])
    expect(split).not.toHaveBeenCalled()
  })

  it('queries git ignored paths only for dotfile-visible rows', () => {
    const treeInput = input({
      '/repo': [row('src/index.ts'), row('.env'), row('src/.generated/output.ts')]
    })

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual([
      'src/index.ts',
      '.env',
      'src/.generated/output.ts'
    ])
    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, false)).toEqual(['src/index.ts'])
  })

  it('queries ignored paths only through expanded directories', () => {
    const treeInput = input(
      {
        '/repo': [row('src', true, 0), row('collapsed', true, 0)],
        '/repo/src': [row('src/index.ts', false, 1)],
        '/repo/collapsed': [row('collapsed/hidden.ts', false, 1)]
      },
      ['/repo/src']
    )

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual([
      'src',
      'src/index.ts',
      'collapsed'
    ])
  })

  it('chunks large filtered projections and accounts for ancestor-row bytes before commit', async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `root/dir-${index}/target-${index}.ts`)
    const nameFilter = { query: 'target', relativePaths: paths }
    const controller = new AbortController()

    expect(shouldBuildNameFilterProjectionInChunks(paths)).toBe(true)
    const projection = await createNameFilteredFileExplorerProjectionInChunks({
      ignoredSet: new Set(),
      nameFilter,
      showDotfiles: true,
      showGitIgnoredFiles: true,
      worktreePath: '/repo',
      signal: controller.signal
    })

    expect(projection.getVisibleCount()).toBe(301)
    expect(getFileExplorerNameFilterProjectionEstimatedBytes(projection)).toBeGreaterThan(
      paths.length * 100
    )
    expect(getFileExplorerNameFilterProjectionEstimatedBytes(projection)).toBeLessThan(
      MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES
    )
  })

  it('preserves natural sibling order and directory promotion across shared prefixes', async () => {
    const nameFilter = {
      query: 'a',
      relativePaths: ['a', 'a/10.ts', 'a.ts', 'a/2.ts']
    }
    const options = {
      ignoredSet: new Set<string>(),
      nameFilter,
      showDotfiles: true,
      showGitIgnoredFiles: true,
      worktreePath: '/repo'
    }
    const synchronous = createNameFilteredFileExplorerProjection(options)
    const chunked = await createNameFilteredFileExplorerProjectionInChunks({
      ...options,
      worktreePath: '/repo/chunked',
      signal: new AbortController().signal
    })
    const visibleRowFields = (projection: typeof synchronous) =>
      projection.getVisibleSlice(0, 10).map(({ relativePath, name, depth, isDirectory }) => ({
        relativePath,
        name,
        depth,
        isDirectory
      }))

    expect(visibleRowFields(chunked)).toEqual(visibleRowFields(synchronous))
    expect(chunked.getVisibleSlice(0, 10).map((row) => row.relativePath)).toEqual([
      'a',
      'a/2.ts',
      'a/10.ts',
      'a.ts'
    ])
    expect(chunked.getRowAtIndex(0)?.isDirectory).toBe(true)
  })

  it('keeps a deep shared-prefix projection in sub-frame chunks with one complete result', async () => {
    const sharedPrefix = Array.from({ length: 64 }, (_, index) => `shared-${index}`).join('/')
    const paths = Array.from(
      { length: 5_000 },
      (_, index) => `${sharedPrefix}/target-${index.toString().padStart(5, '0')}.ts`
    )
    const chunkDurations: number[] = []
    const projection = await createNameFilteredFileExplorerProjectionInChunks({
      ignoredSet: new Set(),
      nameFilter: {
        query: 'target',
        relativePaths: paths,
        workspacePathSearch: makeStructuredPathPage(paths, 'target')
      },
      showDotfiles: true,
      showGitIgnoredFiles: true,
      worktreePath: '/repo',
      signal: new AbortController().signal,
      onChunkDuration: (milliseconds) => chunkDurations.push(milliseconds)
    })

    expect(chunkDurations.length).toBeGreaterThan(1)
    expect(Math.max(...chunkDurations)).toBeLessThan(16)
    expect(projection.getVisibleCount()).toBe(paths.length + 64)
    expect(projection.getRowAtIndex(projection.getVisibleCount() - 1)?.relativePath).toBe(
      paths.at(-1)
    )
    const rows = projection.getVisibleSlice(0, projection.getVisibleCount() - 1)
    const exactBytes = rows.reduce(
      (total, row) =>
        total +
        getUtf8ByteLength(row.name) +
        getUtf8ByteLength(row.path) +
        getUtf8ByteLength(row.relativePath) +
        64,
      0
    )
    expect(getFileExplorerNameFilterProjectionEstimatedBytes(projection)).toBe(exactBytes)
  })

  it('rejects an ancestor-heavy projection before it can exceed the byte bound', async () => {
    const paths = Array.from(
      { length: 8 },
      (_, index) => `branch-${index}/${'deep/'.repeat(2_000)}target-${index}.ts`
    )

    await expect(
      createNameFilteredFileExplorerProjectionInChunks({
        ignoredSet: new Set(),
        nameFilter: { query: 'target', relativePaths: paths },
        showDotfiles: true,
        showGitIgnoredFiles: true,
        worktreePath: '/repo',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('projection byte budget')
  })

  it('cancels a chunked filtered projection before publishing partial rows', async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `root/dir-${index}/target-${index}.ts`)
    const controller = new AbortController()
    controller.abort()

    await expect(
      createNameFilteredFileExplorerProjectionInChunks({
        ignoredSet: new Set(),
        nameFilter: { query: 'target', relativePaths: paths },
        showDotfiles: true,
        showGitIgnoredFiles: true,
        worktreePath: '/repo',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps same-worktree ignored paths while an expanded-folder query is loading', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-1',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/repo'
      })
    ).toEqual(['out'])
  })

  it('does not read a missing ignored-path result when no worktree is active', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: null,
        canLoadIgnoredPaths: true,
        ignoredPathResult: null,
        worktreePath: null
      })
    ).toEqual([])
  })

  it('does not reuse ignored paths across worktree contexts', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-2',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/repo'
      })
    ).toEqual([])

    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-1',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/other-repo'
      })
    ).toEqual([])
  })
})
