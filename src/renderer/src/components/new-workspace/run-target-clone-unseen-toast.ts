import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { ERROR_TOAST_DURATION } from '@/store/repos/repo-state'
import type { ProjectCloneOutcome } from './project-clone-in-flight'

/**
 * Reports a clone outcome no composer could show, because it closed — or moved to another host —
 * before the outcome landed.
 *
 * Why a toast rather than the row: the composer is gone, and the clone it started would otherwise
 * leave the user believing the project is being set up on that host. A taken folder is not a failed
 * clone — that check runs before anything is cloned — so it says what was found and that nothing ran.
 */
export function toastUnseenRunTargetClone({
  projectName,
  hostLabel,
  outcome
}: {
  projectName: string
  hostLabel: string
  outcome: ProjectCloneOutcome
}): void {
  if (outcome.kind === 'failed') {
    // Why: the store already toasted this one; a second toast for one failure is worse than none.
    if (outcome.alreadyToasted) {
      return
    }
    toast.error(
      translate(
        'auto.components.NewWorkspaceComposerCard.cloneFailedOnHostToast',
        "Couldn't clone {{project}} onto {{host}}",
        { project: projectName, host: hostLabel }
      ),
      { description: outcome.message, duration: ERROR_TOAST_DURATION }
    )
    return
  }
  if (outcome.kind === 'folder-taken') {
    toast.warning(
      translate(
        'auto.components.NewWorkspaceComposerCard.cloneSkippedOnHostToast',
        "Didn't clone {{project}} onto {{host}}",
        { project: projectName, host: hostLabel }
      ),
      {
        description: translate(
          'auto.components.NewWorkspaceComposerCard.cloneSkippedFolderTaken',
          '{{path}} already exists. Pick {{host}} again to clone under another name, or use that folder.',
          { path: outcome.path, host: hostLabel }
        ),
        duration: ERROR_TOAST_DURATION
      }
    )
  }
}
