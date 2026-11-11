import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import type { RepoKind } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/**
 * What a host row without the project can actually do when chosen.
 *
 * `refused` keeps the host's own reason (unhealthy, no server, host-local project, setup in
 * progress): the row shows that sentence and commits to nothing, so a row never looks automatic and
 * then fails. The other two are decided from facts the composer holds — the project's kind and the
 * remote it was cloned from — because those decide whether a clone can be attempted at all.
 */
export type RunTargetCloneAvailability =
  | { kind: 'clone' }
  | { kind: 'existing-folder-only'; reason: string }
  | { kind: 'refused' }

export function getRunTargetCloneAvailability(
  option: Pick<NeedsSetupProjectHostOption, 'canSetLocation'>,
  { projectKind, cloneUrl }: { projectKind: RepoKind; cloneUrl: string },
  t: Translate = translate
): RunTargetCloneAvailability {
  if (!option.canSetLocation) {
    return { kind: 'refused' }
  }
  if (projectKind !== 'git') {
    return {
      kind: 'existing-folder-only',
      reason: t(
        'auto.components.NewWorkspaceComposerCard.cloneNeedsGitProject',
        'Only a Git project can be cloned. Use a folder that already exists on this host.'
      )
    }
  }
  if (!cloneUrl.trim()) {
    return {
      kind: 'existing-folder-only',
      reason: t(
        'auto.components.NewWorkspaceComposerCard.cloneNeedsRemote',
        'This project has no remote to clone from. Use a folder that already exists on this host.'
      )
    }
  }
  return { kind: 'clone' }
}
