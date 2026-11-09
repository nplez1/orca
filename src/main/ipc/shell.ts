/* eslint-disable max-lines -- Why: upstream-owned and at its budget; the fork's 18-code-line delta rides inside it, and splitting costs a permanent sync hunk. */
import { translateMain } from '../i18n/main-i18n'
import { BrowserWindow, ipcMain, shell } from 'electron'
import { showSingleFlightOpenDialog } from './single-flight-open-dialog'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, posix, win32 } from 'node:path'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenFileResult,
  ShellOpenLocalPathResult
} from '../../shared/shell/opening/shell-open-types'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../shared/repo-icon'
import {
  repoIconPickFailure,
  type RepoIconPickResult
} from '../../shared/repo-icon-pick-failure-copy'
import type { Store } from '../persistence/loading-store/store'
import {
  EXTERNAL_EDITOR_CLI_COMMAND,
  launchExternalEditor,
  resolveExternalEditorLaunchSpec
} from '../external-editors/external-editor-launch'
import { resolveRemoteSshEditorLaunchSpec } from '../external-editors/remote-ssh-editor-launch'
import { resolveOpenInEditorCommand } from '../external-editors/open-in-editor-command'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  isEditorSshHostForOwner,
  listAppRuntimeEnvironments,
  type ListRuntimeEnvironments
} from './shell-editor-ssh-host'
import {
  isLocallyOwned,
  resolveDefaultAppOpenTarget,
  resolveOwnedPathTarget,
  localFileUriPath
} from './shell-owned-path-target'
import {
  registerContextualLinkRouterHandshake,
  relayContextualLink
} from '../window/contextual-link-relay'
import { inspectLinkedFile } from './linked-file-inspection'
import { registerShellPathExistenceHandlers } from './shell-path-existence-handlers'

export { EXTERNAL_EDITOR_CLI_COMMAND }

const REPO_ICON_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png'
}

async function openInFileManager(
  pathValue: string,
  ownerHostId: unknown
): Promise<ShellOpenLocalPathResult> {
  const target = await resolveOwnedPathTarget(pathValue, ownerHostId)
  if (!target.ok) {
    return target
  }
  try {
    shell.showItemInFolder(target.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

type ShellHandlerStore = Pick<Store, 'getSshTarget'> & {
  getSettings: () => Pick<ReturnType<Store['getSettings']>, 'openInApplications'>
}

async function openInExternalEditor(
  store: ShellHandlerStore,
  request: ShellOpenExternalEditorRequest,
  listRuntimeEnvironments: ListRuntimeEnvironments
): Promise<ShellOpenExternalEditorResult> {
  const command = resolveOpenInEditorCommand(request, store.getSettings().openInApplications)
  if (command === null) {
    return { ok: false, reason: 'launch-failed' }
  }
  const connectionId = request.connectionId?.trim()
  if (connectionId) {
    const sshTarget = store.getSshTarget(connectionId)
    if (!sshTarget) {
      return request.ownerHostId === toSshExecutionHostId(connectionId)
        ? { ok: false, reason: 'ssh-target-not-found' }
        : { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!isEditorSshHostForOwner(sshTarget, request.ownerHostId, listRuntimeEnvironments)) {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (sshTarget.owner?.type === 'on-demand-runtime') {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!posix.isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
      return { ok: false, reason: 'not-absolute' }
    }
    const remoteLaunch = resolveRemoteSshEditorLaunchSpec(command, request.path, sshTarget)
    if (!remoteLaunch.ok) {
      return remoteLaunch
    }
    try {
      await launchExternalEditor(remoteLaunch.launchSpec)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }

  const target = await resolveOwnedPathTarget(request.path, request.ownerHostId)
  if (!target.ok) {
    return target
  }
  try {
    // VS Code and Cursor derive --remote wsl+<distro> from UNC paths.
    await launchExternalEditor(resolveExternalEditorLaunchSpec(command, target.path))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

/** Accepts web URLs only: OS handoff must never receive file:, javascript:, or a custom scheme. */
function httpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/**
 * Open a linked file with the OS default app unless that would run it. Launchable binaries and
 * bundles are revealed; launchable text (scripts) is revealed too, or with `textInEditor` left to
 * the caller to show in Orca. Main decides; the renderer only learns the outcome.
 */
async function openWithSystemDefault(
  pathValue: string,
  ownerHostId: unknown,
  textInEditor: boolean
): Promise<ShellOpenFileResult> {
  if (!isLocallyOwned(ownerHostId)) {
    return 'failed'
  }
  // Why not `validateLocalPathTarget`: this handler is reachable from a markdown link, so the file
  // type decides whether the OS may execute it.
  const target = await resolveDefaultAppOpenTarget(pathValue)
  if (!target.ok) {
    return 'failed'
  }
  try {
    const action = await inspectLinkedFile(target.path)
    if (action === 'view-as-text' && textInEditor) {
      return 'open-in-editor'
    }
    if (action !== 'open') {
      shell.showItemInFolder(target.path)
      return 'revealed'
    }
    const errorMessage = await shell.openPath(target.path)
    return errorMessage.length === 0 ? 'opened' : 'failed'
  } catch {
    return 'failed'
  }
}

export function registerShellHandlers(
  store: ShellHandlerStore,
  listRuntimeEnvironments: ListRuntimeEnvironments = listAppRuntimeEnvironments
): void {
  ipcMain.handle(
    'shell:openPath',
    async (_event, path: string, ownerHostId: unknown): Promise<void> => {
      // Preserve the legacy fire-and-forget contract while applying the common path validation.
      void (await openInFileManager(path, ownerHostId))
    }
  )

  ipcMain.handle(
    'shell:openInFileManager',
    (_event, path: string, ownerHostId: unknown): Promise<ShellOpenLocalPathResult> =>
      openInFileManager(path, ownerHostId)
  )

  ipcMain.handle(
    'shell:openInExternalEditor',
    (_event, request: ShellOpenExternalEditorRequest): Promise<ShellOpenExternalEditorResult> =>
      openInExternalEditor(store, request, listRuntimeEnvironments)
  )

  registerContextualLinkRouterHandshake()

  // Every in-app link open funnels here, so the user's link-routing preference decides the
  // destination and a window without a router still falls back to the OS browser.
  ipcMain.handle('shell:openUrl', (event, rawUrl: string): Promise<void> | undefined => {
    const url = httpUrl(rawUrl)
    if (!url) {
      return undefined
    }
    if (relayContextualLink(event.sender, url)) {
      return undefined
    }
    return shell.openExternal(url)
  })

  // Explicit handoff to the OS browser: used by the "Open in System Browser" actions and by the
  // router's own system-browser branch, which must not relay back into the router.
  ipcMain.handle(
    'shell:openUrlInSystemBrowser',
    (_event, rawUrl: string): Promise<void> | undefined => {
      const url = httpUrl(rawUrl)
      return url ? shell.openExternal(url) : undefined
    }
  )

  ipcMain.handle(
    'shell:openFilePath',
    async (_event, filePath: string, ownerHostId: unknown): Promise<boolean> =>
      (await openWithSystemDefault(filePath, ownerHostId, false)) !== 'failed'
  )

  ipcMain.handle(
    'shell:openFileUri',
    async (_event, rawUri: string, ownerHostId: unknown): Promise<ShellOpenFileResult> => {
      const filePath = localFileUriPath(rawUri)
      // Callers of this channel show `open-in-editor` results in an Orca editor tab.
      return filePath === null ? 'failed' : openWithSystemDefault(filePath, ownerHostId, true)
    }
  )

  registerShellPathExistenceHandlers()

  ipcMain.handle(
    'shell:pickDirectory',
    async (event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await showSingleFlightOpenDialog(
        {
          defaultPath: args.defaultPath,
          // macOS creation-enabled pickers can create typed prefixes; this picker grants existing folders only.
          properties: ['openDirectory']
        },
        BrowserWindow.fromWebContents(event.sender)
      )
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Native dialogs avoid Electron prompt/file-input reliability issues.
  ipcMain.handle('shell:pickAttachment', async (event): Promise<string | null> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile']
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Keep single-file callers, including interpreter selection, on pickAttachment.
  ipcMain.handle('shell:pickAttachments', async (event): Promise<string[]> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile', 'multiSelections']
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('shell:pickImage', async (event): Promise<string | null> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile'],
        filters: [
          {
            name: translateMain('native.dialog.images', 'Images'),
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
          }
        ]
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('shell:pickRepoIconImage', async (event): Promise<RepoIconPickResult> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile'],
        filters: [
          {
            name: translateMain('native.dialog.repoIconImages', 'Repo icon images'),
            extensions: ['png']
          }
        ]
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const filePath = result.filePaths[0]
    const extension = extname(filePath).toLowerCase()
    const mimeType = REPO_ICON_IMAGE_MIME_TYPES[extension]
    if (!mimeType) {
      return repoIconPickFailure('notPng')
    }

    const stats = await stat(filePath)
    if (stats.size > MAX_REPO_ICON_UPLOAD_BYTES) {
      return repoIconPickFailure('tooLarge')
    }

    const buffer = await readFile(filePath)
    return {
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      fileName: basename(filePath)
    }
  })

  ipcMain.handle('shell:pickAudio', async (event): Promise<string | null> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile'],
        filters: [
          {
            name: translateMain('native.dialog.audio', 'Audio'),
            extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac']
          }
        ]
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
