/**
 * The URL a clone would use: the Advanced override when it names one, else the project's own remote.
 *
 * Availability reads this too, because a project with no remote is only clonable through the
 * override — deciding a host row from the remote alone contradicts the field the user just filled in.
 */
export function resolveRunTargetCloneUrl(
  overrides: { url: string },
  defaultCloneUrl: string
): string {
  return overrides.url.trim() || defaultCloneUrl.trim()
}
