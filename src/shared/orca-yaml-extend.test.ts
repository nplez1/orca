import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from './orca-yaml'
import { EPHEMERAL_VM_LIFETIME_DURATION_LIMITS } from './ephemeral-vm-lifetime'

function recipeYaml(recipeLines: string[]): string {
  return ['environmentRecipes:', ...recipeLines].join('\n')
}

const BASE = [
  '  - id: cloud-sandbox',
  '    name: Cloud Sandbox',
  '    create: ./scripts/orca-vm/start.sh'
]

describe('orca.yaml environment recipe extend', () => {
  it('parses extend on its own', () => {
    const recipes = parseOrcaYaml(
      recipeYaml([...BASE, '    extend: ./scripts/orca-vm/extend.sh'])
    )?.environmentRecipes

    expect(recipes).toEqual([
      {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: './scripts/orca-vm/start.sh',
        extend: './scripts/orca-vm/extend.sh'
      }
    ])
  })

  it('parses extend with extendDurations, canonicalized and deduped', () => {
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    extend: ./scripts/orca-vm/extend.sh',
        '    extendDurations: [1h, 60m, 24h]'
      ])
    )

    expect(parsed?.environmentRecipeDiagnostics).toBeUndefined()
    expect(parsed?.environmentRecipes?.[0].extendDurations).toEqual(['1h', '1d'])
  })

  it.each([
    ['[90s, 2h]', ['90s', '2h']],
    ['["4H", "1D"]', ['4h', '1d']],
    ['[30m]', ['30m']],
    ['[60s]', ['1m']]
  ])('normalizes extendDurations %s to %j', (durations, expected) => {
    const parsed = parseOrcaYaml(
      recipeYaml([...BASE, '    extend: ./extend.sh', `    extendDurations: ${durations}`])
    )

    expect(parsed?.environmentRecipes?.[0].extendDurations).toEqual(expected)
  })

  it('accepts exactly the maximum number of distinct durations', () => {
    const durations = [60, 120, 180, 240, 300, 360, 420, 480].map((minutes) => `${minutes}m`)
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    extend: ./extend.sh',
        `    extendDurations: [${durations.join(', ')}]`
      ])
    )

    expect(parsed?.environmentRecipes?.[0].extendDurations).toHaveLength(
      EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxDurations
    )
    expect(parsed?.environmentRecipeDiagnostics).toBeUndefined()
  })

  it('drops the recipe when extendDurations exceeds the maximum count', () => {
    const durations = Array.from(
      { length: EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxDurations + 1 },
      (_, index) => `${index + 1}m`
    )
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    extend: ./extend.sh',
        `    extendDurations: [${durations.join(', ')}]`
      ])
    )

    expect(parsed?.environmentRecipes).toBeUndefined()
    expect(parsed?.environmentRecipeDiagnostics).toEqual([
      {
        index: 0,
        field: 'extendDurations',
        message: expect.stringContaining('extendDurations must be 1-8 durations')
      }
    ])
  })

  it('drops the recipe when an entry is unusable, whatever shape it has', () => {
    for (const value of [
      '"4 hours"',
      '"30s"',
      '"31d"',
      '42',
      '[]',
      '[1h, 30s]',
      '[null]',
      '[1h30m]'
    ]) {
      const parsed = parseOrcaYaml(
        recipeYaml([...BASE, '    extend: ./extend.sh', `    extendDurations: ${value}`])
      )

      expect(parsed?.environmentRecipes, `extendDurations: ${value}`).toBeUndefined()
      expect(parsed?.environmentRecipeDiagnostics).toHaveLength(1)
      expect(parsed?.environmentRecipeDiagnostics?.[0]).toMatchObject({
        index: 0,
        field: 'extendDurations'
      })
    }
  })

  it('drops the recipe when extendDurations is declared without extend', () => {
    const parsed = parseOrcaYaml(recipeYaml([...BASE, '    extendDurations: [1h, 4h]']))

    expect(parsed?.environmentRecipes).toBeUndefined()
    expect(parsed?.environmentRecipeDiagnostics).toEqual([
      {
        index: 0,
        field: 'extendDurations',
        message:
          'Recipe "cloud-sandbox" declares extendDurations without extend. Add extend, or remove extendDurations.'
      }
    ])
  })

  it('leaves a recipe without extend or extendDurations unchanged', () => {
    const parsed = parseOrcaYaml(recipeYaml(BASE))

    expect(parsed?.environmentRecipes).toEqual([
      {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: './scripts/orca-vm/start.sh'
      }
    ])
    expect(parsed?.environmentRecipeDiagnostics).toBeUndefined()
  })

  it('gives every diagnostic a rejected recipe, so the renderer never shows an error for a usable recipe', () => {
    // Why: the renderer renders diagnostics as an error string, so a diagnostic without a drop
    // would report a failure the user cannot act on while the recipe still works.
    const cases: string[][] = [
      [...BASE, '    extend: ./extend.sh', '    extendDurations: [1h, 30s]'],
      [...BASE, '    extendDurations: [1h]'],
      [...BASE, '    extend: ./extend.sh', '    extendDurations: []'],
      [
        ...BASE,
        '    extend: ./extend.sh',
        '    extendDurations: [1d, 2d, 3d, 4d, 5d, 6d, 7d, 8d, 9d]'
      ],
      [...BASE, '    extend: ./extend.sh', '    extendDurations: [31d]']
    ]

    for (const recipe of cases) {
      const parsed = parseOrcaYaml(recipeYaml(recipe))
      expect(parsed?.environmentRecipeDiagnostics?.length, recipe.join(' | ')).toBeGreaterThan(0)
      expect(parsed?.environmentRecipes, recipe.join(' | ')).toBeUndefined()
    }
  })

  it('rejects an invalid extendDurations without discarding a valid sibling recipe', () => {
    const parsed = parseOrcaYaml(
      recipeYaml([
        '  - id: bad-extend',
        '    name: Bad Extend',
        '    create: ./create.sh',
        '    extend: ./extend.sh',
        '    extendDurations: [30s]',
        '  - id: good-extend',
        '    name: Good Extend',
        '    create: ./create.sh',
        '    extend: ./extend.sh',
        '    extendDurations: [1h, 4h]'
      ])
    )

    expect(parsed?.environmentRecipes).toEqual([
      {
        id: 'good-extend',
        name: 'Good Extend',
        create: './create.sh',
        extend: './extend.sh',
        extendDurations: ['1h', '4h']
      }
    ])
    expect(parsed?.environmentRecipeDiagnostics).toEqual([
      { index: 0, field: 'extendDurations', message: expect.stringContaining('bad-extend') }
    ])
  })
})
