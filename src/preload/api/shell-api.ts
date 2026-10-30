import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'

export type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'

export type ShellApi = {
  /** Every OS open names the path's owner; main refuses anything not owned by this computer. */
  openPath: (path: string, ownerHostId: ExecutionHostId) => Promise<void>
  openInFileManager: (
    path: string,
    ownerHostId: ExecutionHostId
  ) => Promise<ShellOpenLocalPathResult>
  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest
  ) => Promise<ShellOpenExternalEditorResult>
  /** Opens a URL at the destination the user's link-routing preference names (Orca's browser by
   *  default), falling back to the system browser when the window cannot route it. */
  openUrl: (url: string) => Promise<void>
  /** Always hands the URL to the OS browser — the explicit "open externally" actions. */
  openUrlInSystemBrowser: (url: string) => Promise<void>
  /** Main → renderer: a link reached the window with no in-app handler. */
  onContextualLinkRequested: (callback: (url: string) => void) => () => void
  /** Announces that this window routes link opens, so main relays instead of opening the OS browser. */
  markContextualLinkRouterReady: () => void
  openFilePath: (path: string, ownerHostId: ExecutionHostId) => Promise<boolean>
  openFileUri: (uri: string, ownerHostId: ExecutionHostId) => Promise<void>
  pathsExist?: (paths: string[]) => Promise<boolean[]>
  pathExists: (path: string) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickAttachments: () => Promise<string[]>
  pickImage: () => Promise<string | null>
  pickRepoIconImage: () => Promise<{
    dataUrl: string
    fileName: string
  } | null>
  pickAudio: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}
