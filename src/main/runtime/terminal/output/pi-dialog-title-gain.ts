import type { AgentStatus } from '../../../../shared/agent-detection'
import { getPiStateTitleStatus } from '../../../../shared/pi-state-title-marker'

/** Tells the hook store the moment a pi pane's own title claims a dialog.
 *
 *  Why the marker's arrival: pi's dialogs paint no tail text the store's on-gain trigger can read,
 *  and most of them emit no hook of their own, so a row a later post displaced would wait for the
 *  next hook post — which an unanswered dialog may never send. `π !` is pi's own claim that one is
 *  open now, and only its transition into the pane is news (#228). */
export function notePiDialogTitleGained(
  rawTitle: string,
  previousStatus: AgentStatus | null,
  status: AgentStatus | null,
  paneKeys: Iterable<string>,
  notify: (paneKey: string) => void
): void {
  if (
    status !== 'permission' ||
    previousStatus === 'permission' ||
    getPiStateTitleStatus(rawTitle) !== 'permission'
  ) {
    return
  }
  for (const paneKey of paneKeys) {
    // Why deferred: this runs inside the PTY data path, before the emulator holds the bytes that
    // paint the dialog, and the store's read repaints a row on that tick.
    queueMicrotask(() => notify(paneKey))
  }
}
