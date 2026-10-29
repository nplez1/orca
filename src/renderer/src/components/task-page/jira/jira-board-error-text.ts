import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

/** Jira's own reason for a refused board action, or the board's own wording when the
 *  failure carries none. Shared by the board and the two hooks that move issues on it,
 *  so the three report the same thing — with the IPC wrapper stripped and the fallback
 *  translated, which is what reaches the user. */
export function jiraBoardErrorText(error: unknown): string {
  return extractIpcErrorMessage(
    error,
    translate('auto.components.TaskPage.jiraBoardUpdateFailed', 'Jira board update failed.')
  )
}
