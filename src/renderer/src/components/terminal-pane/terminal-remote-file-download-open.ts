import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { basename } from '@/lib/path'
import { downloadRuntimeFile, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

/** What the client does with the workspace copy once the save dialog returns a path. */
type RemoteFileDelivery = 'open' | 'reveal'

/**
 * Remote counterpart of the local file rows: the OS can only reach a local file,
 * so the workspace copy is downloaded to a user-chosen path first.
 */
async function downloadRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  delivery: RemoteFileDelivery
): Promise<void> {
  const name = basename(filePath) || filePath
  try {
    const result = fileContext.connectionId
      ? await window.api.fs.downloadFile({ filePath, connectionId: fileContext.connectionId })
      : await downloadRuntimeFile(fileContext, filePath, name)
    // Why: cancelling the native save dialog is a deliberate no-op, not a failure.
    if (result.canceled) {
      return
    }
    if (delivery === 'reveal') {
      // Why clientLocalPath: the save dialog just produced this path on this client, so an active
      // runtime environment must not make main refuse to show it.
      await window.api.shell.openInFileManager(result.destinationPath, { clientLocalPath: true })
      return
    }
    await window.api.shell.openFilePath(result.destinationPath)
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.downloadOpenFailed',
          "Failed to download '{{value0}}'.",
          { value0: name }
        )
      )
    )
  }
}

export function downloadAndOpenRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string
): Promise<void> {
  return downloadRemoteTerminalFile(fileContext, filePath, 'open')
}

/** Remote counterpart of "Show in Finder": reveal the saved copy instead of launching it. */
export function downloadAndRevealRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string
): Promise<void> {
  return downloadRemoteTerminalFile(fileContext, filePath, 'reveal')
}
