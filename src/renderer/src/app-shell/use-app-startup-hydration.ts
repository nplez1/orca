import { restoreStructuredLaunchSurfaces } from '@/lib/structured-agent-session-launch-surface'
import { useEffect, useRef } from 'react'
import { restoreLocalStructuredChatsAtStartup } from '@/runtime/local-structured-chats'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { installCodexDetachedPaneRestartExecutor } from '@/components/terminal-pane/codex-detached-pane-restart-scheduler'
import { useAppStore } from '../store'
import { reconcileHydratedWorkspaceTabModels } from './reconcile-hydrated-workspace-tab-models'
import { useStartupActions } from './use-app-startup-actions'
import { waitForNativeChatDraftsAtStartup } from './native-chat-draft-startup'
import { sweepRestoredCodexPanesForStaleAccounts } from '../lib/codex-stale-pane-sweep'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '../lib/workspace-session-host-hydration'
import { collectFolderWorkspaceKeysFromSession } from '../lib/workspace-session-hydration-keys'
import { hydratePersistedUIAfterStartupRead } from '../lib/startup-ui-hydration'
import {
  logRendererStartupDiagnostic,
  timeRendererStartupStep,
  timeRendererStartupSyncStep
} from '../startup/startup-diagnostics'
import { recoverFromDegradedStartup } from '../startup/startup-degraded-recovery'
import { restoreSshConnectionsForStartup } from '../startup/startup-ssh-connection-restore'
import { collectActiveWorkspaceSshTargetIds } from '../startup/active-workspace-ssh-targets'
import { publishTerminalViewAttributesAtAppStart } from '../components/terminal-pane/terminal-appearance'
import { getSystemPrefersDark } from '../lib/terminal-theme'
import {
  collectTerminalProviderSnapshotPtyIds,
  refreshTerminalProviderSnapshotCapabilities
} from '../components/terminal/terminal-provider-snapshot-capability'
import { isOwnedSshTargetId } from '../../../shared/execution-host'
import { listRuntimeSessionHostIdsForStartup } from './startup-runtime-session-hosts'
import { collectWslMovedWorkspaceKeysFromSession } from '../store/repos/wsl-moved-projects'
import { wslMovedSessionReadApi } from '../store/repos/wsl-moved-local-session-rows'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { ensureLocalRuntimeCapabilities } from '../runtime/local-runtime-capabilities'
import {
  hydrateStartupWorktreeCache,
  startStartupWorktreeCacheRead
} from '../startup/startup-worktree-cache'
import { selectStartupHydrationRepos } from '../startup/startup-worktree-selection'
import { publishStartupTerminalHints } from '../startup/startup-terminal-hints'
import { startLocalCatalogHydration } from '../startup/startup-local-catalog'
import {
  finishStartupWorktreeHydration,
  hydrateStartupWorktrees,
  refreshStartupWorktrees
} from '../startup/startup-worktree-refresh'

/** Hydrate settings/UI/catalog/session, reconnect and restore terminals before unlocking saves. Failure boots in degraded no-save mode to protect disk state. */
export function useAppStartupHydration(onOnboardingLoaded: (state: OnboardingState) => void): void {
  const actions = useStartupActions()
  // Keep callback identity from restarting boot. Sync in the preceding effect so discarded renders cannot publish a callback.
  const onOnboardingLoadedRef = useRef(onOnboardingLoaded)
  useEffect(() => {
    onOnboardingLoadedRef.current = onOnboardingLoaded
  }, [onOnboardingLoaded])

  useEffect(() => installCodexDetachedPaneRestartExecutor(), [])

  useEffect(() => {
    // Ask static capabilities before gated session sync; "not asked" reads unsupported and would turn early creates into bare terminals (#19154).
    void ensureLocalRuntimeCapabilities()
    let cancelled = false
    // Cleanup must abort StrictMode’s discarded boot before it spawns more PTYs.
    const abortController = new AbortController()

    // Hydrate immediately after ui.get: persistedUIReady unlocks its writer, so a later fallback must not save defaults (#1158).
    let uiHydrated = false
    // Recovery must not repeat a partially completed reconnect and double-consume PTY/pending state (#1158).
    let reconnectStarted = false
    void (async () => {
      const startupStartedAt = performance.now()
      logRendererStartupDiagnostic('startup-chain-start')
      try {
        // Profiles need no synchronous read here; overlap their IPC with settings.
        void actions.fetchOrcaProfiles()
        // Publish local settings first; a remote owner’s defaults can wait a full connect timeout.
        await timeRendererStartupStep('fetch-settings', () =>
          actions.fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
        )
        // Publish composed terminal appearance before panes mount so hidden startup PTYs can answer queries.
        const settings = useAppStore.getState().settings
        publishTerminalViewAttributesAtAppStart(settings, getSystemPrefersDark())
        // Overlap keybindings/onboarding with scans; mark rejections handled until their later awaits. Delay browser profiles until runtime connection, since failed reads clear them.
        const keybindingsPromise = timeRendererStartupStep('fetch-keybindings', () =>
          actions.fetchKeybindings()
        )
        keybindingsPromise.catch(() => {})
        const onboardingPromise = timeRendererStartupStep('onboarding-get', () =>
          window.api.onboarding.get()
        )
        onboardingPromise.catch(() => {})
        const cachedWorktreesPromise = startStartupWorktreeCacheRead()
        // Hydrate saved view settings before catalog/session work so first paint reflects them.
        const persistedUI = await timeRendererStartupStep('ui-get', () => window.api.ui.get())
        uiHydrated = timeRendererStartupSyncStep('hydrate-persisted-ui', () =>
          hydratePersistedUIAfterStartupRead({
            persistedUI,
            cancelled,
            hydratePersistedUI: actions.hydratePersistedUI
          })
        )
        // Runtime session hosts need no repo state; overlap their IPC and handle rejection until the later await.
        const runtimeHostsPromise = timeRendererStartupStep(
          'list-runtime-session-hosts',
          listRuntimeSessionHostIdsForStartup
        )
        runtimeHostsPromise.catch(() => {})
        // Before the session read: a moved project's local rows must leave before the host's merge in.
        // Started before the repo list too; this startup load does not prune, so it need not wait.
        const wslMovedProjectsPromise = useAppStore.getState().fetchWslMovedProjects()
        // Skip remote catalogs for first paint; saved runtimes may wait a full connect timeout.
        await timeRendererStartupStep('fetch-repos-local', () =>
          actions.fetchReposForAllHosts({ remoteHosts: 'skip' })
        )
        await timeRendererStartupStep('repo-catalog-settlement', () =>
          actions.awaitLocalRepoCatalogSettlement()
        )
        const cachedWorktreeRepoIds = await hydrateStartupWorktreeCache(
          actions,
          cachedWorktreesPromise
        )
        const localCatalogChain = startLocalCatalogHydration(actions)
        const startupBackgroundChain = Promise.allSettled([
          keybindingsPromise,
          localCatalogChain,
          // Why: native chat drafts share the writers' barrier so they settle before recovery without serialising behind it.
          timeRendererStartupStep('native-chat-drafts', waitForNativeChatDraftsAtStartup)
        ]).then(([keybindingsOutcome, catalogOutcome]) => {
          if (keybindingsOutcome.status === 'rejected') {
            throw keybindingsOutcome.reason
          }
          if (catalogOutcome.status === 'rejected') {
            throw catalogOutcome.reason
          }
        })
        startupBackgroundChain.catch(() => {})
        const sessionReadPromise = Promise.all([runtimeHostsPromise, wslMovedProjectsPromise]).then(
          ([startupRuntimeHostIds]) =>
            // Restore cached runtime-host partitions without network waits; skip unreadable ones.
            timeRendererStartupStep('session-get', () =>
              fetchWorkspaceSessionWithRuntimeHostOwners(
                // A moved workspace's retained rows share tab ids with its host's live ones.
                wslMovedSessionReadApi(useAppStore.getState().wslMovedProjects),
                useAppStore.getState().repos,
                startupRuntimeHostIds
              )
            )
        )
        const hydrationSessionChain = sessionReadPromise.then(async (sessionRead) => {
          const hydrationRepos = selectStartupHydrationRepos(
            useAppStore.getState().repos,
            sessionRead.session,
            sessionRead.runtimeHostIdByWorkspaceSessionKey,
            cachedWorktreeRepoIds
          )
          await hydrateStartupWorktrees(actions, hydrationRepos)
          return sessionRead
        })
        const sessionRead = await hydrationSessionChain
        await timeRendererStartupStep('repo-catalog-final-settlement', () =>
          actions.awaitLocalRepoCatalogSettlement()
        )
        if (!cancelled) {
          const sessionHydrationOptions = {
            additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(
              sessionRead.session
            ),
            wslMovedChatWorkspaceKeys: collectWslMovedWorkspaceKeysFromSession(
              sessionRead.session,
              useAppStore.getState().wslMovedProjects,
              sessionRead.runtimeHostIdByWorkspaceSessionKey
            )
          }
          timeRendererStartupSyncStep('hydrate-session-stores', () => {
            // The read's host-ownership fields are named as the hydration options it feeds.
            actions.hydrateWorkspaceSession(sessionRead.session, {
              ...sessionRead,
              ...sessionHydrationOptions
            })
            actions.hydrateTabsSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateEditorSession(sessionRead.session, sessionHydrationOptions)
            actions.hydrateBrowserSession(sessionRead.session, sessionHydrationOptions)
            reconcileHydratedWorkspaceTabModels(
              sessionRead.session,
              useAppStore.getState().reconcileWorktreeTabModels
            )
          })
          restoreStructuredLaunchSurfaces()
          publishStartupTerminalHints(actions)
          // Why: hints must paint before background startup failures can enter degraded recovery.
          await startupBackgroundChain
          // Discovery must not wait for terminal or SSH restoration.
          const startupWorktreeRefresh = refreshStartupWorktrees(actions, () => cancelled)
          await timeRendererStartupStep('prepare-terminal-startup-restoration', () =>
            window.api.app.prepareTerminalStartupRestoration()
          )
          if (cancelled) {
            return
          }
          // Prune after catalogs hydrate or valid visits disappear; seed missing active-workspace recency (docs/cmd-j-empty-query-ordering.md).
          timeRendererStartupSyncStep('visit-timestamp-prune', () => {
            actions.pruneLastVisitedTimestamps()
            actions.seedActiveWorktreeLastVisitedIfMissing()
          })
          // Browser profiles can take a 15s runtime RPC and do not gate restoration. Start here without awaiting; the action handles its own failure.
          void timeRendererStartupStep('fetch-browser-session-profiles', () =>
            actions.fetchBrowserSessionProfiles()
          ).catch(() => {})
          const onboardingState = await onboardingPromise
          if (!cancelled) {
            onOnboardingLoadedRef.current(onboardingState)
          }

          // Reconnect SSH before PTY attach; defer passphrase targets to focus. Never dial runtime-owned targets here: ssh.connect would dispose the runtime’s relay.
          const connectionIds = (sessionRead.session.activeConnectionIdsAtShutdown ?? []).filter(
            (targetId) => !isOwnedSshTargetId(targetId)
          )
          if (connectionIds.length > 0) {
            try {
              // Await only targets needed for immediately mounted panes; dead background hosts must not stall local restoration.
              const blockingConnectionIds = collectActiveWorkspaceSshTargetIds(
                useAppStore.getState()
              )
              await restoreSshConnectionsForStartup({
                connectionIds,
                blockingConnectionIds,
                setDeferredSshReconnectTargets: actions.setDeferredSshReconnectTargets,
                removeDeferredSshReconnectTarget: actions.removeDeferredSshReconnectTarget,
                publishSshConnectionState: actions.setSshConnectionState
              })
            } catch (err) {
              console.warn('SSH startup reconnect failed:', err)
            }
          } else {
            logRendererStartupDiagnostic('ssh-reconnect-skipped', { connectionIds: 0 })
          }

          // prepare-terminal-startup-restoration already fenced first-window services; main also awaits them here.
          await timeRendererStartupStep('recover-legacy-worker-terminals-pre-reconnect', () =>
            window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
          )
          await timeRendererStartupStep('terminal-provider-snapshot-capabilities', () =>
            refreshTerminalProviderSnapshotCapabilities(
              collectTerminalProviderSnapshotPtyIds(useAppStore.getState())
            )
          )
          reconnectStarted = true
          await timeRendererStartupStep('reconnect-terminals', () =>
            actions.reconnectPersistedTerminals(abortController.signal)
          )
          await timeRendererStartupStep('recover-legacy-worker-terminals-post-reconnect', () =>
            window.api.app.recoverLegacyWorkerTerminalsForRendererStartup()
          )
          await restoreLocalStructuredChatsAtStartup(useAppStore.getState().settings, (restore) =>
            timeRendererStartupStep('project-structured-session-tabs', restore)
          )
          if (cancelled) {
            return
          }
          // After reconnect publishes PTY IDs, re-offer stale Codex accounts even for tabs that never mount.
          sweepRestoredCodexPanesForStaleAccounts(useAppStore.getState())
          syncZoomCSSVar()
          // Unlock writes only after all hydration/dependent steps succeed; never save partially restored state (#1158).
          actions.setHydrationSucceeded(true)
          actions.setTerminalStartupRestorationReady(true)
          void startupWorktreeRefresh.then((results) => {
            if (!cancelled) {
              finishStartupWorktreeHydration(results)
            }
          })
          // Require opt-in dev seeding so empty profiles can exercise onboarding without selection hijacking.
          if (
            import.meta.env.DEV &&
            String(import.meta.env.VITE_ACTIVITY_DEV_FIXTURE).toLowerCase() === 'true'
          ) {
            const { seedDevActivityFixture } =
              await import('../components/activity/dev-activity-fixture')
            seedDevActivityFixture()
          }
          logRendererStartupDiagnostic('startup-hydration-done', {
            durationMs: Math.round(performance.now() - startupStartedAt)
          })
        }
      } catch (error) {
        await recoverFromDegradedStartup({
          error,
          uiHydrated,
          reconnectStarted,
          isCancelled: () => cancelled,
          hydratePersistedUI: actions.hydratePersistedUI,
          reconnectPersistedTerminals: actions.reconnectPersistedTerminals,
          abortSignal: abortController.signal
        })
      }
      void actions.initGitHubCache()
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [actions])
}
