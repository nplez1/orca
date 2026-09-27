import { describe, expect, it } from 'vitest'
import {
  generateWorkspacePathCatalog,
  WORKSPACE_PATH_CATALOG_EDGE_PATHS
} from './__fixtures__/workspace-path-catalog'

describe('workspace path catalog generator', () => {
  it('is deterministic for matching seeds, sizes, and profiles', () => {
    for (const profile of ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const) {
      const first = [...generateWorkspacePathCatalog({ size: 256, profile, seed: 17 })]
      const second = [...generateWorkspacePathCatalog({ size: 256, profile, seed: 17 })]
      expect(first).toEqual(second)
      expect(new Set(first).size).toBe(first.length)
    }
  })

  it('streams exactly the requested number of paths and varies by seed', () => {
    const options = { size: 128, profile: 'realistic-shared-prefixes' as const }
    const first = [...generateWorkspacePathCatalog({ ...options, seed: 1 })]
    const second = [...generateWorkspacePathCatalog({ ...options, seed: 2 })]
    expect(first).toHaveLength(options.size)
    expect(first).not.toEqual(second)
    expect([...generateWorkspacePathCatalog({ size: 0, profile: options.profile })]).toEqual([])
  })

  it('covers the planned Unicode, natural-sort, mixed-case, slash, and dotfile corpus', () => {
    const generated = [
      ...generateWorkspacePathCatalog({ size: 128, profile: 'realistic-shared-prefixes' })
    ]
    for (const edgePath of WORKSPACE_PATH_CATALOG_EDGE_PATHS) {
      expect(generated).toContain(edgePath)
    }
    expect(generated).toContain('src/shared/İstanbul/data.ts')
    expect(generated).toContain('src/shared/ısparta/data.ts')
    expect(generated).toContain('src/unicode/cafe\u0301.ts')
    expect(generated).toContain('src/unicode/𐐀-module/index.ts')
    expect(generated).toContain('src/components/Button/item-2.ts')
    expect(generated).toContain('src/components/Button/item-02.ts')
    expect(generated).toContain('src/components/Button/item-10.ts')
    expect(generated).toContain('src/.generated/target-hidden.ts')
  })

  it('creates shared dense prefixes and longer near-unique adversarial paths', () => {
    const realistic = [
      ...generateWorkspacePathCatalog({ size: 512, profile: 'realistic-shared-prefixes' })
    ]
    const adversarial = [
      ...generateWorkspacePathCatalog({ size: 512, profile: 'adversarial-long-unshared' })
    ]
    const realisticGenerated = realistic.slice(WORKSPACE_PATH_CATALOG_EDGE_PATHS.length)
    const adversarialGenerated = adversarial.slice(WORKSPACE_PATH_CATALOG_EDGE_PATHS.length)

    expect(
      realisticGenerated.filter((path) => path.startsWith('node_modules/')).length
    ).toBeGreaterThan(20)
    expect(realisticGenerated.some((path) => path.endsWith('/index.ts'))).toBe(true)
    expect(new Set(adversarialGenerated.map((path) => path.split('/')[0])).size).toBe(
      adversarialGenerated.length
    )
    expect(averageLength(adversarialGenerated)).toBeGreaterThan(averageLength(realisticGenerated))
  })

  it('rejects invalid sizes', () => {
    expect(() => [
      ...generateWorkspacePathCatalog({ size: -1, profile: 'realistic-shared-prefixes' })
    ]).toThrow(RangeError)
    expect(() => [
      ...generateWorkspacePathCatalog({ size: 1.5, profile: 'adversarial-long-unshared' })
    ]).toThrow(RangeError)
  })
})

function averageLength(paths: readonly string[]): number {
  return paths.reduce((sum, path) => sum + path.length, 0) / paths.length
}
