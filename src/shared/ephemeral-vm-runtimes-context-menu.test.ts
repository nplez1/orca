import { describe, expect, it } from 'vitest'
import type { OrcaVmRecipe, OrcaVmRecipeContextMenuItem } from './orca-yaml-hook-types'
import {
  EphemeralVmRuntimeRecordSchema,
  isEphemeralVmHostActionable,
  isReleasedEphemeralVmRuntime,
  toEphemeralVmRuntimeContextMenuFields,
  toEphemeralVmRuntimeRecipeSnapshot,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'
import { projectRuntimeForRollback } from './ephemeral-vm-runtime-rollback-projection'

const ITEMS = [
  { id: 'launch-vnc', label: 'Launch VNC', command: './local/orca-vm/launch-vnc.sh' },
  { id: 'launch-rdp', label: 'Launch RDP', command: './local/orca-vm/launch-rdp.sh' }
]

function recipe(overrides: Partial<OrcaVmRecipe> = {}): OrcaVmRecipe {
  return { id: 'team-machine', name: 'Team machine', create: './create.sh', ...overrides }
}

function record(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'team-machine',
    recipe: toEphemeralVmRuntimeRecipeSnapshot(recipe()),
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'pair-1',
      projectRoot: '/workspace/repo'
    },
    ...overrides
  }
}

describe('ephemeral VM runtime context menu items', () => {
  it('keeps the declared items off the strict recipe snapshot', () => {
    // Why the snapshot stays clean: it is strict, so an item an older build cannot parse would
    // make the whole runtime store unreadable to it.
    const snapshot = toEphemeralVmRuntimeRecipeSnapshot(
      recipe({ contextMenuItems: ITEMS, extend: './extend.sh', extendDurations: ['4h'] })
    )

    expect(snapshot).toEqual({ id: 'team-machine', name: 'Team machine', create: './create.sh' })
    expect(snapshot).not.toHaveProperty('contextMenuItems')
  })

  it('copies the declared items onto the record fields', () => {
    expect(toEphemeralVmRuntimeContextMenuFields(recipe({ contextMenuItems: ITEMS }))).toEqual({
      contextMenuItems: ITEMS
    })
  })

  it('omits the fields when the recipe declares no items', () => {
    expect(toEphemeralVmRuntimeContextMenuFields(recipe())).toEqual({})
    expect(toEphemeralVmRuntimeContextMenuFields(recipe({ contextMenuItems: [] }))).toEqual({})
  })

  it('drops anything but id, label and command from a declared item', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a plugin recipe can hand back extra keys at runtime, which the type cannot express.
    const smuggled = {
      ...ITEMS[0]!,
      sandbox: true
    } as OrcaVmRecipeContextMenuItem

    expect(toEphemeralVmRuntimeContextMenuFields(recipe({ contextMenuItems: [smuggled] }))).toEqual(
      {
        contextMenuItems: [ITEMS[0]]
      }
    )
  })

  it('round-trips items through the record schema', () => {
    const parsed = EphemeralVmRuntimeRecordSchema.parse(
      record({ contextMenuItems: ITEMS, extend: './extend.sh', extendDurations: ['4h'] })
    )

    expect(parsed.contextMenuItems).toEqual(ITEMS)
  })

  it('reads a record written before the field existed', () => {
    const parsed = EphemeralVmRuntimeRecordSchema.parse(record())

    expect(parsed.contextMenuItems).toBeUndefined()
  })

  it('rejects an item with an unknown key rather than the whole record', () => {
    // Why strict per item: the item list is snapshotted script launchers, so an unexpected key is
    // a recipe bug worth surfacing instead of silently carrying into the store.
    const itemWithExtraKey: unknown = { ...ITEMS[0]!, sandbox: true }
    const result = EphemeralVmRuntimeRecordSchema.safeParse({
      ...record(),
      contextMenuItems: [itemWithExtraKey]
    })

    expect(result.success).toBe(false)
  })

  it('keeps the items in the projection a rollback and recovery write stores', () => {
    // Why: that projection is what a downgrade reads back, and dropping the items there would strip
    // every existing workspace's menu on the way down.
    expect(projectRuntimeForRollback(record({ contextMenuItems: ITEMS })).contextMenuItems).toEqual(
      ITEMS
    )
  })
})

describe('isEphemeralVmHostActionable', () => {
  it.each([
    ['a running host', record(), true],
    ['a suspended host', record({ status: 'suspended' }), true],
    ['a host being torn down', record({ status: 'cleanup_pending' }), false],
    ['a cleaned host', record({ status: 'cleaned', cleanupStatus: 'succeeded' }), false],
    ['a reclaimed host', record({ status: 'running', reclaimedAt: 1 }), false]
  ])('%s is %s', (_name, runtime, expected) => {
    expect(isEphemeralVmHostActionable(runtime)).toBe(expected)
  })

  it('refuses a host being torn down that isReleased would still call live', () => {
    const teardown = record({ status: 'cleanup_pending' })

    expect(isReleasedEphemeralVmRuntime(teardown)).toBe(false)
    expect(isEphemeralVmHostActionable(teardown)).toBe(false)
  })
})
