import {
  EPHEMERAL_VM_LIFETIME_DURATION_LIMITS,
  normalizeEphemeralVmLifetimeDuration
} from './ephemeral-vm-lifetime'
import { asRecord, asTrimmedString } from './orca-yaml-fields'
import { MAX_ORCA_YAML_COLLECTION_ENTRIES } from './orca-yaml-file-limit'
import type {
  OrcaVmRecipe,
  OrcaVmRecipeContextMenuItem,
  OrcaVmRecipeDiagnostic
} from './orca-yaml-hook-types'

/** The `environmentRecipes` half of `orca.yaml`, kept out of the generic hook parser. */

export const ORCA_VM_RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const ORCA_VM_RECIPE_ID_RULE =
  'Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'
export const MAX_VM_RECIPE_CONTEXT_MENU_ITEMS = 20

export type VmRecipeParseResult = {
  recipes: OrcaVmRecipe[]
  diagnostics: OrcaVmRecipeDiagnostic[]
}

type ContextMenuItemsParseResult = {
  items: OrcaVmRecipeContextMenuItem[]
  error?: string
}

/**
 * Validated `contextMenuItems` for one recipe; the whole recipe is rejected on a bad entry.
 *
 * Why reject rather than drop the entry: an action that silently never appears is
 * indistinguishable from a typo the author already fixed, and every other recipe-level mistake
 * (a bad `extendDurations`, a duplicate id) is reported the same way.
 */
function normalizeVmRecipeContextMenuItems(value: unknown): ContextMenuItemsParseResult {
  if (value === undefined) {
    return { items: [] }
  }
  if (!Array.isArray(value)) {
    return { items: [], error: 'contextMenuItems must be a list.' }
  }
  if (value.length > MAX_VM_RECIPE_CONTEXT_MENU_ITEMS) {
    return {
      items: [],
      error: `contextMenuItems accepts at most ${MAX_VM_RECIPE_CONTEXT_MENU_ITEMS} items.`
    }
  }

  const items: OrcaVmRecipeContextMenuItem[] = []
  const seenIds = new Set<string>()
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) {
      return { items: [], error: 'has a contextMenuItems entry that is not a mapping.' }
    }
    const id = asTrimmedString(record.id)
    const label = asTrimmedString(record.label)
    const command = asTrimmedString(record.command)
    if (!id || !ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
      return {
        items: [],
        error: `has a contextMenuItems entry with an invalid id. ${ORCA_VM_RECIPE_ID_RULE}`
      }
    }
    if (!label) {
      return { items: [], error: `contextMenuItems entry "${id}" is missing label.` }
    }
    if (!command) {
      return { items: [], error: `contextMenuItems entry "${id}" is missing command.` }
    }
    if (seenIds.has(id)) {
      return { items: [], error: `has a duplicate contextMenuItems id "${id}".` }
    }
    seenIds.add(id)
    items.push({ id, label, command })
  }
  return { items }
}

/** Canonicalized, deduped `extendDurations`; null when the value cannot be used as written. */
function normalizeVmRecipeExtendDurations(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  if (value.length > EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxDurations) {
    return null
  }
  const durations: string[] = []
  for (const entry of value) {
    const raw = asTrimmedString(entry)
    const normalized = raw ? normalizeEphemeralVmLifetimeDuration(raw) : null
    if (!normalized) {
      return null
    }
    if (!durations.includes(normalized)) {
      durations.push(normalized)
    }
  }
  return durations
}

export function normalizeVmRecipes(value: unknown): VmRecipeParseResult {
  const diagnostics: OrcaVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { recipes: [], diagnostics }
  }
  if (value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return {
      recipes: [],
      diagnostics: [
        {
          index: MAX_ORCA_YAML_COLLECTION_ENTRIES,
          message: `At most ${MAX_ORCA_YAML_COLLECTION_ENTRIES} environment recipes are supported.`
        }
      ]
    }
  }

  const seenIds = new Set<string>()
  const recipes = value
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) {
        diagnostics.push({
          index,
          message: 'Recipe entry must be a mapping.'
        })
        return null
      }
      const id = asTrimmedString(record.id)
      const name = asTrimmedString(record.name)
      const create = asTrimmedString(record.create) ?? asTrimmedString(record.command)
      if (!id) {
        diagnostics.push({ index, field: 'id', message: 'Recipe id is required.' })
        return null
      }
      if (!ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Invalid recipe id "${id}". ${ORCA_VM_RECIPE_ID_RULE}`
        })
        return null
      }
      if (seenIds.has(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Duplicate recipe id "${id}". Recipe ids must be unique.`
        })
        return null
      }
      if (!name) {
        diagnostics.push({ index, field: 'name', message: `Recipe "${id}" is missing name.` })
        return null
      }
      if (!create) {
        diagnostics.push({ index, field: 'create', message: `Recipe "${id}" is missing create.` })
        return null
      }
      seenIds.add(id)
      const description = asTrimmedString(record.description)
      const checkoutMode = asTrimmedString(record.checkoutMode)
      if (checkoutMode && checkoutMode !== 'orca-worktree' && checkoutMode !== 'provisioned-root') {
        diagnostics.push({
          index,
          field: 'checkoutMode',
          message: `Recipe "${id}" checkoutMode must be "orca-worktree" or "provisioned-root".`
        })
        return null
      }
      const suspend = asTrimmedString(record.suspend)
      const resume = asTrimmedString(record.resume)
      const destroyValue = asTrimmedString(record.destroy) ?? asTrimmedString(record.cleanup)
      const destroyDisabled = destroyValue === 'none'
      const extend = asTrimmedString(record.extend)
      const extendDurations =
        record.extendDurations === undefined
          ? []
          : normalizeVmRecipeExtendDurations(record.extendDurations)
      if (extendDurations === null) {
        diagnostics.push({
          index,
          field: 'extendDurations',
          message: `Recipe "${id}" extendDurations must be 1-${EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxDurations} durations of at least ${EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.minSeconds}s, such as 4h or 1d.`
        })
        return null
      }
      // Why: choices Orca can never offer are a misconfiguration, and dropping the recipe
      // keeps the module's invariant that every diagnostic names a rejected recipe.
      if (extendDurations.length > 0 && !extend) {
        diagnostics.push({
          index,
          field: 'extendDurations',
          message: `Recipe "${id}" declares extendDurations without extend. Add extend, or remove extendDurations.`
        })
        return null
      }
      const contextMenuItems = normalizeVmRecipeContextMenuItems(record.contextMenuItems)
      if (contextMenuItems.error) {
        diagnostics.push({
          index,
          field: 'contextMenuItems',
          message: `Recipe "${id}" ${contextMenuItems.error}`
        })
        return null
      }
      return {
        id,
        name,
        create,
        ...(checkoutMode ? { checkoutMode } : {}),
        ...(description ? { description } : {}),
        ...(suspend ? { suspend } : {}),
        ...(resume ? { resume } : {}),
        ...(destroyValue && !destroyDisabled ? { destroy: destroyValue } : {}),
        ...(destroyDisabled ? { destroyDisabled: true } : {}),
        ...(extend ? { extend } : {}),
        ...(extendDurations.length > 0 ? { extendDurations } : {}),
        ...(contextMenuItems.items.length > 0 ? { contextMenuItems: contextMenuItems.items } : {})
      }
    })
    .filter((entry): entry is OrcaVmRecipe => entry !== null)
  return { recipes, diagnostics }
}
