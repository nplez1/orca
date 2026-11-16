import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const idle = () => vi.fn()
const settled = () => vi.fn(async () => {})

// Every module the will-quit teardown reaches, shaped as the quit path calls it.
const dependencies: Record<string, Record<string, unknown>> = {
  '../../ipc/filesystem/watchers/filesystem-watcher-shutdown': { closeAllWatchers: settled() },
  '../../ipc/worktrees/creation/worktree-base-directory-watcher': {
    disposeWorktreeBaseDirectoryWatchers: settled()
  },
  '../../ipc/folder-repo-git-upgrade': { stopFolderRepoGitUpgradeWatch: idle() },
  '../../ipc/pty/kill-all': { killAllPty: idle() },
  '../../daemon/providers/lifecycle/daemon-provider-state': {
    disconnectDaemon: settled(),
    shutdownDaemon: settled()
  },
  '../../ipc/ssh/ssh-shutdown-drain': { beginSshShutdown: settled() },
  '../../agent-hooks/server/agent-hook-server': { agentHookServer: { stop: idle() } },
  '../../agent-hooks/wsl-relay/wsl-hook-relay-manager': {
    wslHookRelayManager: { disposeAll: idle() }
  },
  '../../agent-hooks/installation/managed-agent-hook-controls': {
    removeManagedAgentHooksAsync: vi.fn(async () => [])
  },
  '../../runtime/agent-session/structured-agent-session-runtime': {
    stopStructuredAgentSessionRuntime: settled()
  },
  '../../runtime/agent-session/structured-agent-session-runtime-teardown': {
    setStructuredAgentSessionTeardownTrigger: idle()
  },
  '../../runtime/files/watch/file-watcher-leases': {
    awaitRuntimeFileWatcherUnsubscribes: settled()
  },
  '../../runtime/rpc/server/runtime-metadata': { clearRuntimeMetadataIfOwned: idle() },
  '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime': {
    shutdownPairedRuntimeBrowserClientHosts: settled()
  },
  '../../ipc/browser/desktop-browser-bridge-wiring': { disposeDesktopBrowserBridge: idle() },
  '../../orca-profiles/cloud-session/profile-cloud-session-owner': {
    flushUnsavedCloudSessions: idle()
  },
  '../../browser/guest-lifecycle/manager/browser-manager': {
    browserManager: { setBrowserGuestStateChangedListener: idle(), setOffscreenTabOpener: idle() }
  },
  '../../browser/sessions/profiles/browser-session-registry': { browserSessionRegistry: {} },
  '../../browser/cookies/session-restore/browser-session-cookie-restore': {
    flushBrowserSessionCookiesOnQuit: settled()
  },
  '../../browser/extensions/profile-storage/browser-extension-profile-document-store': {
    closeBrowserExtensionProfileDocumentStores: idle()
  },
  '../../codex/history/index/codex-state-db-backfill-recovery': {
    stopCodexStateDbBackfillRecoveries: settled()
  },
  '../../codex/history/bridges/codex-account-session-bridge': {
    stopCodexAccountSessionBridges: idle()
  },
  '../../git/refs/maintenance/local-repo-ref-maintenance': {
    awaitPackedRefsLockRelease: settled()
  },
  '../../workspaces/removal/worktree-background-removal': { stopBackgroundWorktreeRemovals: idle() },
  '../../dock/unread-badge': { setUnreadDockBadgeCount: idle() },
  '../../tray/system-tray': { destroySystemTray: idle() },
  '../../telemetry/client': { shutdownTelemetry: settled() },
  '../../observability/index': { shutdownObservability: settled() },
  '../../updater/updater-service': { isQuittingForUpdate: vi.fn(() => false) },
  '../../updater/updater-lifecycle-diagnostics': { recordUpdaterLifecycle: idle() },
  '../../updater/lifecycle/serve-supervisor-install-park': {
    pendingServeSupervisorQuitCommit: settled()
  },
  '../../macos-permissions/macos-tcc-prompt-notice': { stopTccPromptNotice: idle() },
  '../../pty/history/terminal-history-gc': { cancelHistoryGc: idle() },
  '../../persistence/profile-shutdown-checkpoint': {
    beginProfileShutdownCheckpoint: vi.fn(async () => {})
  },
  '../../wsl/execution/wsl-command-channel': { killWslChannelsInCloseGrace: idle() },
  '../../diagnostics/ui-hang-log-sink': { closeUiHangLogSink: idle() },
  '../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client': {
    closeEnvironmentStore: idle()
  },
  '../cloud-startup/main-process-connector-startup': { desktopConnectorCloud: () => null },
  './window-all-closed-quit-policy': { shouldQuitWhenAllWindowsClosed: vi.fn(() => false) },
  '../configure-process': { isDevParentShutdownRequested: vi.fn(() => false) },
  '../../persistence/loading-store/user-data-path': {
    getCanonicalUserDataPath: vi.fn(() => '/unused')
  }
}

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('../main-process-state')
  for (const moduleName of Object.keys(dependencies)) {
    vi.doUnmock(moduleName)
  }
  vi.restoreAllMocks()
  vi.resetModules()
})

it('keeps startup services live through a vetoed before-quit and stops them at will-quit', async () => {
  vi.resetModules()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const fenceAndCloseNow = vi.fn()
  const setMobileRelayPairingProvider = vi.fn()
  const unsubscribeAgentAwakeStatusChanges = vi.fn()
  const dispose = vi.fn()
  const stop = vi.fn()
  const state = {
    isQuitting: false,
    desktopRelayService: { fenceAndCloseNow },
    runtimeRpc: { setMobileRelayPairingProvider, stop: settled() },
    unsubscribeAgentAwakeStatusChanges,
    agentAwakeService: { dispose },
    rateLimits: { stop }
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('../main-process-state', () => ({ mainProcessState: state }))
  for (const [moduleName, exports] of Object.entries(dependencies)) {
    vi.doMock(moduleName, () => exports)
  }
  const exitListenersBefore = process.listeners('exit')
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  const { quitTeardownStartGate } = await import('./quit-teardown-start-gate')
  quitTeardownStartGate.resetForTests()
  installMainProcessQuitHandlers()

  app.emit('before-quit', { defaultPrevented: true })

  expect(state.isQuitting).toBe(false)
  expect(fenceAndCloseNow).not.toHaveBeenCalled()
  expect(setMobileRelayPairingProvider).not.toHaveBeenCalled()
  expect(unsubscribeAgentAwakeStatusChanges).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(state.agentAwakeService).toEqual({ dispose })
  expect(state.unsubscribeAgentAwakeStatusChanges).toBe(unsubscribeAgentAwakeStatusChanges)

  app.emit('before-quit', { defaultPrevented: false })

  // A renderer close guard can still veto before-quit, so nothing is torn down here.
  expect(state.isQuitting).toBe(true)
  expect(fenceAndCloseNow).not.toHaveBeenCalled()
  expect(unsubscribeAgentAwakeStatusChanges).not.toHaveBeenCalled()

  app.emit('will-quit', { preventDefault: vi.fn() })

  expect(fenceAndCloseNow).toHaveBeenCalledOnce()
  expect(setMobileRelayPairingProvider).toHaveBeenCalledWith(null)
  expect(unsubscribeAgentAwakeStatusChanges).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.includes(listener)) {
      process.removeListener('exit', listener)
    }
  }
})
