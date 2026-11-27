import { closeEnvironmentStore } from '../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import { app, type Event } from 'electron'
import { closeUiHangLogSink } from '../../diagnostics/ui-hang-log-sink'
import { flushUnsavedCloudSessions } from '../../orca-profiles/cloud-session/profile-cloud-session-owner'
import { awaitPackedRefsLockRelease } from '../../git/refs/maintenance/local-repo-ref-maintenance'
import { cancelHistoryGc } from '../../pty/history/terminal-history-gc'
import { shutdownPairedRuntimeBrowserClientHosts } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { closeAllPairedPortForwards } from '../../ports/paired-forwards/paired-port-forwards'
import { disposeDesktopBrowserBridge } from '../../ipc/browser/desktop-browser-bridge-wiring'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import {
  finishQuitTeardown,
  quitTeardownDeadlineMs,
  quitWorkerStoreDeadlineMs,
  type NamedQuitTeardown
} from './quit-teardown-deadline'
import { quitTeardownStartGate } from './quit-teardown-start-gate'
import { abortPluginGitForShutdown } from '../../plugins/installation/plugin-git-repository'
import { destroySystemTray } from '../../tray/system-tray'
import { shutdownTelemetry } from '../../telemetry/client'
import { shutdownObservability } from '../../observability/index'
import { applyTeamPolicyBeforeQuit, isQuittingForUpdate } from '../../updater/updater-service'
import { recordUpdaterLifecycle } from '../../updater/updater-lifecycle-diagnostics'
import { pendingServeSupervisorQuitCommit } from '../../updater/lifecycle/serve-supervisor-install-park'
import { stopTccPromptNotice } from '../../macos-permissions/macos-tcc-prompt-notice'
import { installWindowAllClosedHandler } from './window-all-closed-quit-handler'
import { mainProcessState as state } from '../main-process-state'
import { isDevParentShutdownRequested } from '../configure-process'
import { closeBrowserExtensionProfileDocumentStores } from '../../browser/extensions/profile-storage/browser-extension-profile-document-store'
import { closeBrowserExtensionProfileStateStore } from '../../browser/extensions/profile-storage/browser-extension-profile-state-store'
import { flushBrowserSessionCookiesOnQuit } from '../../browser/cookies/session-restore/browser-session-cookie-restore'
import {
  beginDesktopCoreShutdown,
  fenceDesktopCore
} from '../../core-desktop/desktop-core-shutdown'

// First will-quit pass awaits teardown; the re-fired pass must exit without starting writes again.
let daemonDisconnectDone = false

function installBeforeQuitHandler(): void {
  app.on('before-quit', (event: Event) => {
    if (event.defaultPrevented) {
      return
    }
    applyTeamPolicyBeforeQuit()
    if (isQuittingForUpdate()) {
      recordUpdaterLifecycle('before_quit_allowed', undefined, {
        message: 'before-quit allowed for update install'
      })
    }
    state.isQuitting = true
    flushUnsavedCloudSessions()
    // Beforeunload may veto; wait for ref locks now but uninstall only after committed quit. isQuitting already blocks new attempts.
    state.core.repoMaintenanceShutdown = awaitPackedRefsLockRelease()
    // History GC is idempotent and rescheduled next launch; a vetoed quit costs only a deferred sweep.
    cancelHistoryGc()
  })
}

function stopNativeObserversAndTray(updateQuitInProgress: boolean): void {
  state.unsubscribeSystemResumeBroadcast?.()
  state.unsubscribeSystemResumeBroadcast = null
  state.unsubscribeWakeSignalClock?.()
  state.unsubscribeWakeSignalClock = null
  state.stopDesktopPresenceReporter?.()
  state.stopDesktopPresenceReporter = null
  state.uninstallMainThreadStallProbe?.()
  state.uninstallMainThreadStallProbe = null
  state.uninstallUiHangLifecycleObserver?.()
  state.uninstallUiHangLifecycleObserver = null
  // Why: renderer guards can still cancel before this committed phase; `log stream` must survive those vetoes.
  stopTccPromptNotice()
  if (updateQuitInProgress) {
    recordUpdaterLifecycle(
      'will_quit_cleanup_started',
      { daemonTeardown: 'disconnect' },
      { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
    )
  }
  // Remove the Windows tray icon only after renderer vetoes are past.
  destroySystemTray()
}

function retireBrowsers(): NamedQuitTeardown[] {
  const browserSessionCookieFlush = flushBrowserSessionCookiesOnQuit()
  // Await per-session close children so browser daemons cannot retain ports/state after quit (#16367); retire headless owners first to avoid duplicate fanout.
  const browserShutdown = (async (): Promise<void> => {
    await state.core.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
    await state.core.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  })()
  // Local SSH browser routes own loopback listeners and ssh -N -D children that must not outlive the app (P2-4).
  const localSshRouteShutdown =
    import('../../browser/routing/local-host-partitions/local-ssh-browser-route')
      .then((routes) => routes.closeAllLocalSshBrowserRoutes())
      .catch(() => {})
  browserManager.setBrowserGuestStateChangedListener(null)
  browserManager.setOffscreenTabOpener(null)
  browserManager.setServerPagePopupPresenter(null)
  return [
    { name: 'browser', promise: browserShutdown },
    { name: 'browser-session-cookies', promise: browserSessionCookieFlush },
    { name: 'local-ssh-browser-routes', promise: localSshRouteShutdown }
  ]
}

function installWillQuitHandler(): void {
  app.on('will-quit', (event: Event) => {
    // The second pass must not start fresh writes that process exit would interrupt.
    if (daemonDisconnectDone) {
      return
    }
    // Prevent exit before awaiting work. Synchronous network-profile writes would block the same thread as their deadline timer (#9447).
    if (!quitTeardownStartGate.tryStart(event)) {
      return
    }
    // Not awaited: signals catalog git to stop without delaying quit; the startup sweep catches leftovers.
    abortPluginGitForShutdown()
    // Why here and not before-quit: a renderer close guard can still veto, and stopping these there
    // left the app open with no agent-awake service and no rate-limit polling (A6). will-quit is past
    // every veto.
    fenceDesktopCore(state.core, () => {
      state.unsubscribeAgentAwakeStatusChanges?.()
      state.unsubscribeAgentAwakeStatusChanges = null
      state.agentAwakeService?.dispose()
      state.agentAwakeService = null
    })
    // A Claude OAuth exchange spends the old refresh token server-side, so a rotation the keychain
    // refused is the only copy of a working login (#212). Why guarded and not awaited: the startup flush
    // has already hydrated the queue, so this is one in-memory check unless something is really waiting,
    // and quit must not wait on a keychain prompt.
    void import('../../claude-accounts/claude-oauth-pending-rotations')
      .then((rotations) =>
        rotations.hasPendingClaudeOAuthRotations()
          ? rotations.flushPendingClaudeOAuthRotations()
          : undefined
      )
      .catch(() => {})
    const updateQuitInProgress = isQuittingForUpdate()
    const coreTeardowns = beginDesktopCoreShutdown(
      state.core,
      {
        store: state.store,
        releaseAdmission: () => {
          state.profileStateAdmission?.release()
          state.profileStateAdmission = undefined
        }
      },
      updateQuitInProgress ? 'update' : 'quit',
      {
        afterPushStopped: () => stopNativeObserversAndTray(updateQuitInProgress),
        retireBrowsers,
        stopUsageBackend: () => state.backend?.stop(),
        retireBrowserClientHosts: () => {
          disposeDesktopBrowserBridge()
          return [
            { name: 'browser-client-hosts', promise: shutdownPairedRuntimeBrowserClientHosts() },
            { name: 'paired-port-forwards', promise: closeAllPairedPortForwards() }
          ]
        },
        isDevParentShutdown: isDevParentShutdownRequested
      }
    )
    // Bound unsettled transports so quit cannot hang (#9447); atomic swaps preserve old files if a debounce is lost.
    void finishQuitTeardown({
      teardowns: [
        ...coreTeardowns,
        { name: 'install-park', promise: pendingServeSupervisorQuitCommit() }
      ],
      deadlineMs: quitTeardownDeadlineMs(updateQuitInProgress),
      // After the teardown, so they save every write it accepted; each never rejects.
      closeDataStores: () =>
        Promise.all([
          closeBrowserExtensionProfileDocumentStores(),
          closeBrowserExtensionProfileStateStore()
        ]),
      closeWorkerStores: closeEnvironmentStore,
      workerStoreDeadlineMs: quitWorkerStoreDeadlineMs(updateQuitInProgress),
      shutdownDiagnostics: async () => {
        await shutdownTelemetry()
        await shutdownObservability()
        closeUiHangLogSink()
      }
    }).then(() => {
      daemonDisconnectDone = true
      app.quit()
    })
  })
}

export function installMainProcessQuitHandlers(): void {
  // app.exit skips Electron quit events; stop the log child on forced exits too.
  process.once('exit', stopTccPromptNotice)
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
