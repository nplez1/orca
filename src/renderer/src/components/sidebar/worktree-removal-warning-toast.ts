import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * The workspace is gone; this reports what the host could not finish, such as a folder it could not
 * delete. A warning that is never shown is the same as no warning, so this is the removal's only
 * channel for "done, but read this".
 */
export function showWorktreeRemovalWarningToast(warning: string): void {
  toast.warning(
    translate(
      'auto.components.sidebar.worktree.removal.warning.title',
      'Workspace deleted with a warning'
    ),
    { description: warning, duration: 12_000 }
  )
}
