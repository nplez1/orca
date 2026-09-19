import {
  getTerminalFileContext,
  mapTerminalFilePath,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from './terminal-link-action-request'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  downloadAndOpenRemoteTerminalFile,
  downloadAndRevealRemoteTerminalFile
} from './terminal-remote-file-download-open'
import { translate } from '@/i18n/i18n'

type RevealWordings = { local: string; afterDownload: string }

/** Platform-appropriate file-manager wording: macOS → Finder, Windows → File Explorer, Linux → Files. */
function revealWordings(): RevealWordings {
  if (navigator.userAgent.includes('Mac')) {
    return {
      local: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.showInFinder',
        'Show in Finder'
      ),
      afterDownload: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.downloadShowInFinder',
        'Download & show in Finder'
      )
    }
  }
  if (navigator.userAgent.includes('Linux')) {
    return {
      local: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.showInFiles',
        'Show in Files'
      ),
      afterDownload: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.downloadShowInFiles',
        'Download & show in Files'
      )
    }
  }
  return {
    local: translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.showInFileExplorer',
      'Show in File Explorer'
    ),
    afterDownload: translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.downloadShowInFileExplorer',
      'Download & show in File Explorer'
    )
  }
}

export type TerminalFileLinkActionDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
}

export function handleTerminalFileLink(
  filePath: string,
  line: number | null,
  column: number | null,
  event: MouseEvent | undefined,
  deps: TerminalFileLinkActionDeps,
  actionContext?: TerminalLinkActionContext | null,
  actionDestination?: string
): boolean {
  if (isTerminalLinkDirectActivation(event)) {
    event?.preventDefault?.()
    openDetectedFilePath(filePath, line, column, {
      ...deps,
      openWithSystemDefault: Boolean(event?.shiftKey)
    })
    return true
  }

  const mappedPath = mapTerminalFilePath(
    filePath,
    deps.worktreePath,
    terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
  )
  const fileContext = getTerminalFileContext(
    deps.worktreeId,
    deps.worktreePath,
    deps.runtimeEnvironmentId
  )
  const worktreeRoot = resolveKnownWorktreeRootPathLink(mappedPath)
  const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext, mappedPath)
  const isMac = navigator.userAgent.includes('Mac')
  // Why the trailing separator and not a stat: the popover is built synchronously on hover, and a
  // remote stat per link would put a round-trip in front of every terminal path. A directory
  // that does not announce itself with a separator still fails visibly, in the download toast.
  const endsWithDirectorySeparator = /[/\\]$/.test(mappedPath)
  const revealWording = revealWordings()

  // Why: the OS can only launch a local file, so remote links keep the same row by
  // downloading first — local and remote workspaces offer the same actions.
  const systemDefaultRow = worktreeRoot
    ? canOpenWithSystemDefault
      ? {
          label: isMac
            ? translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.openInFinder',
                'Open in Finder'
              )
            : translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.openFolder',
                'Open folder'
              ),
          run: () =>
            openDetectedFilePath(filePath, line, column, { ...deps, openWithSystemDefault: true })
        }
      : null
    : canOpenWithSystemDefault
      ? {
          label: translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openWithDefaultApp',
            'Open with default app'
          ),
          run: () =>
            openDetectedFilePath(filePath, line, column, { ...deps, openWithSystemDefault: true })
        }
      : endsWithDirectorySeparator
        ? null
        : {
            label: translate(
              'auto.components.terminal.pane.TerminalLinkActionPopover.downloadOpenWithDefaultApp',
              'Download & open with default app'
            ),
            run: () => downloadAndOpenRemoteTerminalFile(fileContext, mappedPath)
          }

  // Why the last row and no shortcut: showing the file in the file manager is the action the
  // platform cannot express as a modifier gesture, and a workspace root already reveals itself
  // through its open row. A directory has nothing worth handing to the file manager remotely.
  // Why clientLocalPath: both rows resolved their path as this client's own — the local pane
  // through its owner, the remote one through the save dialog — so an active runtime environment
  // must not make main refuse a path that is genuinely here.
  const revealRow = worktreeRoot
    ? null
    : canOpenWithSystemDefault
      ? {
          label: revealWording.local,
          run: () => void window.api.shell.openInFileManager(mappedPath, { clientLocalPath: true })
        }
      : endsWithDirectorySeparator
        ? null
        : {
            label: revealWording.afterDownload,
            run: () => void downloadAndRevealRemoteTerminalFile(fileContext, mappedPath)
          }

  return requestTerminalLinkAction(event, actionContext, {
    destination: actionDestination ?? mappedPath,
    kind: worktreeRoot ? 'workspace' : 'file',
    primary: {
      label: worktreeRoot
        ? translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.switchWorkspace',
            'Switch workspace'
          )
        : translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openFile',
            'Open file'
          ),
      run: () => openDetectedFilePath(filePath, line, column, deps)
    },
    ...(systemDefaultRow ? { alternate: systemDefaultRow } : {}),
    ...(revealRow ? { tertiary: revealRow } : {})
  })
}
