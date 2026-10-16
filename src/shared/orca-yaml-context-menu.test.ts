import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from './orca-yaml'
import { MAX_VM_RECIPE_CONTEXT_MENU_ITEMS } from './orca-yaml-vm-recipes'

function recipeYaml(recipeLines: string[]): string {
  return ['environmentRecipes:', ...recipeLines].join('\n')
}

const BASE = [
  '  - id: team-machine',
  '    name: Team machine',
  '    create: ./local/orca-vm/create.sh'
]

describe('orca.yaml environment recipe context menu items', () => {
  it('parses declared items in order', () => {
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    contextMenuItems:',
        '      - id: launch-vnc',
        '        label: Launch VNC',
        '        command: ./local/orca-vm/launch-vnc.sh',
        '      - id: launch-rdp',
        '        label: Launch RDP',
        '        command: ./local/orca-vm/launch-rdp.sh'
      ])
    )

    expect(parsed?.environmentRecipeDiagnostics).toBeUndefined()
    expect(parsed?.environmentRecipes?.[0].contextMenuItems).toEqual([
      { id: 'launch-vnc', label: 'Launch VNC', command: './local/orca-vm/launch-vnc.sh' },
      { id: 'launch-rdp', label: 'Launch RDP', command: './local/orca-vm/launch-rdp.sh' }
    ])
  })

  it('omits the field entirely when no item is declared', () => {
    const parsed = parseOrcaYaml(recipeYaml(BASE))

    expect(parsed?.environmentRecipes?.[0]).not.toHaveProperty('contextMenuItems')
  })

  it('omits the field for an explicitly empty list', () => {
    const parsed = parseOrcaYaml(recipeYaml([...BASE, '    contextMenuItems: []']))

    expect(parsed?.environmentRecipeDiagnostics).toBeUndefined()
    expect(parsed?.environmentRecipes?.[0]).not.toHaveProperty('contextMenuItems')
  })

  it('trims the label and command it keeps', () => {
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    contextMenuItems:',
        '      - id: launch-vnc',
        '        label: "  Launch VNC  "',
        '        command: "  ./local/orca-vm/launch-vnc.sh  "'
      ])
    )

    expect(parsed?.environmentRecipes?.[0].contextMenuItems).toEqual([
      { id: 'launch-vnc', label: 'Launch VNC', command: './local/orca-vm/launch-vnc.sh' }
    ])
  })

  it('accepts exactly the maximum number of items', () => {
    const items = Array.from({ length: MAX_VM_RECIPE_CONTEXT_MENU_ITEMS }, (_value, index) => [
      `      - id: item-${index}`,
      `        label: Item ${index}`,
      `        command: ./scripts/orca-vm/item-${index}.sh`
    ]).flat()
    const parsed = parseOrcaYaml(recipeYaml([...BASE, '    contextMenuItems:', ...items]))

    expect(parsed?.environmentRecipes?.[0].contextMenuItems).toHaveLength(
      MAX_VM_RECIPE_CONTEXT_MENU_ITEMS
    )
  })

  it.each([
    [
      'a non-list value',
      ['    contextMenuItems: ./scripts/orca-vm/menu.sh'],
      'contextMenuItems must be a list.'
    ],
    [
      'an entry that is not a mapping',
      ['    contextMenuItems:', '      - launch-vnc'],
      'has a contextMenuItems entry that is not a mapping.'
    ],
    [
      'a missing id',
      ['    contextMenuItems:', '      - label: Launch VNC', '        command: ./launch.sh'],
      'has a contextMenuItems entry with an invalid id.'
    ],
    [
      'an invalid id',
      [
        '    contextMenuItems:',
        '      - id: Launch VNC',
        '        label: Launch VNC',
        '        command: ./launch.sh'
      ],
      'has a contextMenuItems entry with an invalid id.'
    ],
    [
      'a missing label',
      ['    contextMenuItems:', '      - id: launch-vnc', '        command: ./launch.sh'],
      'contextMenuItems entry "launch-vnc" is missing label.'
    ],
    [
      'a missing command',
      ['    contextMenuItems:', '      - id: launch-vnc', '        label: Launch VNC'],
      'contextMenuItems entry "launch-vnc" is missing command.'
    ],
    [
      'a blank label',
      [
        '    contextMenuItems:',
        '      - id: launch-vnc',
        '        label: "   "',
        '        command: ./launch.sh'
      ],
      'contextMenuItems entry "launch-vnc" is missing label.'
    ],
    [
      'duplicate ids',
      [
        '    contextMenuItems:',
        '      - id: launch-vnc',
        '        label: Launch VNC',
        '        command: ./launch.sh',
        '      - id: launch-vnc',
        '        label: Launch VNC again',
        '        command: ./launch-2.sh'
      ],
      'has a duplicate contextMenuItems id "launch-vnc".'
    ]
  ])('rejects the whole recipe for %s', (_name, recipeLines, expected) => {
    const parsed = parseOrcaYaml(recipeYaml([...BASE, ...recipeLines]))

    // Why the whole recipe: a silently dropped action looks exactly like a typo the author
    // already fixed, so a bad entry names the rejected recipe instead.
    expect(parsed?.environmentRecipes).toBeUndefined()
    const diagnostics = parsed?.environmentRecipeDiagnostics ?? []
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ index: 0, field: 'contextMenuItems' })
    expect(diagnostics[0]?.message).toContain(`Recipe "team-machine" ${expected}`)
  })

  it('rejects more items than the cap allows', () => {
    const items = Array.from({ length: MAX_VM_RECIPE_CONTEXT_MENU_ITEMS + 1 }, (_value, index) => [
      `      - id: item-${index}`,
      `        label: Item ${index}`,
      `        command: ./scripts/orca-vm/item-${index}.sh`
    ]).flat()
    const parsed = parseOrcaYaml(recipeYaml([...BASE, '    contextMenuItems:', ...items]))

    expect(parsed?.environmentRecipes).toBeUndefined()
    expect(parsed?.environmentRecipeDiagnostics?.[0]?.message).toContain(
      `Recipe "team-machine" contextMenuItems accepts at most ${MAX_VM_RECIPE_CONTEXT_MENU_ITEMS} items.`
    )
  })

  it('keeps a rejected recipe from hiding the recipes that follow it', () => {
    const parsed = parseOrcaYaml(
      recipeYaml([
        ...BASE,
        '    contextMenuItems: ./scripts/orca-vm/menu.sh',
        '  - id: other-machine',
        '    name: Other machine',
        '    create: ./local/orca-vm/other-create.sh'
      ])
    )

    expect(parsed?.environmentRecipes?.map((recipe) => recipe.id)).toEqual(['other-machine'])
    expect(parsed?.environmentRecipeDiagnostics).toHaveLength(1)
  })
})
