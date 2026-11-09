import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'

/** The environment recipe commands a vmRecipe trust approval covers. */
export function getVmRecipeTrustContent(yamlHooks: OrcaHooks | null): string {
  return (yamlHooks?.environmentRecipes ?? [])
    .map((recipe) =>
      [
        `# environmentRecipes.${recipe.id}`,
        `name: ${recipe.name}`,
        recipe.description ? `description: ${recipe.description}` : null,
        `create: ${recipe.create}`,
        recipe.suspend ? `suspend: ${recipe.suspend}` : null,
        recipe.resume ? `resume: ${recipe.resume}` : null,
        recipe.extend ? `extend: ${recipe.extend}` : null,
        recipe.extendDurations?.length
          ? `extendDurations: ${recipe.extendDurations.join(', ')}`
          : null,
        recipe.destroyDisabled
          ? 'destroy: none'
          : recipe.destroy
            ? `destroy: ${recipe.destroy}`
            : null,
        ...(recipe.contextMenuItems ?? []).map(
          (item) => `contextMenuItems.${item.id} (${item.label}): ${item.command}`
        )
      ]
        .filter((entry): entry is string => entry !== null)
        .join('\n')
    )
    .join('\n\n')
}
