export const WORKSPACE_PATH_CATALOG_SIZES = [100_000, 300_000, 500_000, 1_000_000] as const

export type WorkspacePathCatalogSize = (typeof WORKSPACE_PATH_CATALOG_SIZES)[number]
export type WorkspacePathCatalogProfile = 'realistic-shared-prefixes' | 'adversarial-long-unshared'

export type WorkspacePathCatalogOptions = {
  size: number
  profile: WorkspacePathCatalogProfile
  seed?: number
}

export const WORKSPACE_PATH_CATALOG_EDGE_PATHS = [
  'src/components/Button/index.ts',
  'src/components/button/index.ts',
  'src/components/Button/item-2.ts',
  'src/components/Button/item-02.ts',
  'src/components/Button/item-10.ts',
  'src/shared/İstanbul/data.ts',
  'src/shared/ısparta/data.ts',
  'src/unicode/cafe\u0301.ts',
  'src/unicode/𐐀-module/index.ts',
  'src/components/Button/ButtonView.tsx',
  '.env',
  '.config/settings.json',
  'src/.generated/target-hidden.ts',
  'ignored/reports/target-ignored.ts',
  'packages/app/src/excluded-target.ts',
  'node_modules/@types/react/index.d.ts',
  'node_modules/pkg-cache/deep/target.ts',
  '.git/config',
  'src/long-paths/long-budget-target-αβγδεζηθικλμνξοπρστυφχψω.ts'
] as const

/** Streams exactly `size` unique, forward-slash relative paths without retaining the catalog. */
export function* generateWorkspacePathCatalog({
  size,
  profile,
  seed = 0x4f524341
}: WorkspacePathCatalogOptions): Generator<string> {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`Catalog size must be a non-negative safe integer; received ${size}`)
  }

  const random = createSeededRandom(seed)
  const edgeCount = Math.min(size, WORKSPACE_PATH_CATALOG_EDGE_PATHS.length)
  for (let index = 0; index < edgeCount; index += 1) {
    yield WORKSPACE_PATH_CATALOG_EDGE_PATHS[index]!
  }

  for (let index = edgeCount; index < size; index += 1) {
    const generatedIndex = index - WORKSPACE_PATH_CATALOG_EDGE_PATHS.length
    const randomValue = random()
    yield profile === 'realistic-shared-prefixes'
      ? makeRealisticPath(generatedIndex, randomValue)
      : makeAdversarialPath(generatedIndex, randomValue)
  }
}

/** Generates a bounded census whose query `cardinality match` has exactly `matchCount` results. */
export function* generatePathMatchCardinalityCatalog(
  matchCount: number,
  decoyCount = 3
): Generator<string> {
  if (!Number.isSafeInteger(matchCount) || matchCount < 0) {
    throw new RangeError(`Match count must be a non-negative safe integer; received ${matchCount}`)
  }
  if (!Number.isSafeInteger(decoyCount) || decoyCount < 0) {
    throw new RangeError(`Decoy count must be a non-negative safe integer; received ${decoyCount}`)
  }

  for (let index = 0; index < matchCount; index += 1) {
    yield `src/cardinality/cardinality-match-${index.toString(36)}.ts`
  }
  for (let index = 0; index < decoyCount; index += 1) {
    yield `src/cardinality/cardinality-decoy-${index.toString(36)}.ts`
  }
}

function makeRealisticPath(index: number, randomValue: number): string {
  const group = randomValue % 6
  const sharedRoots = [
    'src/components',
    'src/shared',
    'src/main',
    'tests/unit',
    'packages/desktop/src',
    'packages/cli/src'
  ]
  const root = sharedRoots[group]!
  const moduleName = `module-${index.toString(36)}`
  const baseName = commonFileName(index, randomValue)

  if (randomValue % 5 === 0) {
    return `node_modules/@scope-${randomValue % 32}/package-${moduleName}/dist/${baseName}`
  }
  return `${root}/feature-${randomValue % 64}/${moduleName}/${baseName}`
}

function makeAdversarialPath(index: number, randomValue: number): string {
  const identifier = index.toString(36).padStart(7, '0')
  const randomPart = randomValue.toString(36).padStart(7, '0')
  const longSegment = `unshared-segment-${identifier}-${randomPart}`
  const basename = index % 4 === 0 ? 'index.ts' : `payload-${identifier}-${randomPart}.tsx`
  return [
    `workspace-${identifier}-${randomPart}`,
    `${longSegment}-alpha`,
    `${longSegment}-beta`,
    `${longSegment}-gamma`,
    `${longSegment}-delta`,
    basename
  ].join('/')
}

function commonFileName(index: number, randomValue: number): string {
  switch ((index + randomValue) % 8) {
    case 0:
      return 'index.ts'
    case 1:
      return 'README.md'
    case 2:
      return 'config.json'
    case 3:
      return 'test.spec.ts'
    case 4:
      return `component-${index.toString(36)}.tsx`
    case 5:
      return `module-${index.toString(36)}.js`
    case 6:
      return `view-${index.toString(36)}.tsx`
    default:
      return `file-${index.toString(36)}.ts`
  }
}

function createSeededRandom(seed: number): () => number {
  let state = Number.isFinite(seed) ? seed >>> 0 : 0x4f524341
  if (state === 0) {
    state = 0x6d2b79f5
  }
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}
