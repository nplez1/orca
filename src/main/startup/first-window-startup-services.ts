type FirstWindowStartupServices = {
  startDaemonPtyProvider: (signal: AbortSignal) => Promise<void>
  startAgentHookServer: (signal: AbortSignal) => Promise<void> | AgentHookServerStartup
  onDaemonError: (error: unknown) => void
  onAgentHookServerError: (error: unknown) => void
}

export type AgentHookServerStartup = {
  ready: Promise<void>
  statusCacheHydrationReady: Promise<void>
}

type StartupService = {
  ready: Promise<void>
  earlyReady: Promise<void>
  reportTimeout: () => void
}

type StartupServiceStart = Promise<void> | AgentHookServerStartup

type FirstWindowStartupServicesResult = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
  localPtyProviderReady: Promise<void>
  agentHookStatusCacheHydrationReady: Promise<void>
}

export const FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS = 12_000
// Why: a slow (but succeeding) daemon start must not flip terminals to the
// LocalPtyProvider fallback — local PTYs are killed on quit, so panes bound to
// them lose their daemon sessions permanently (#5232). The PTY gate therefore
// waits for the daemon attempt itself and only fail-opens at a hard cap that
// exists solely as a deadlock backstop.
export const LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS = 60_000

function startService(
  label: string,
  start: (signal: AbortSignal) => StartupServiceStart,
  onError: (error: unknown) => void
): StartupService {
  const abortController = new AbortController()
  let settled = false
  let reportedTimeout = false
  let resolveEarlyReady!: () => void
  let resolveFailOpen!: () => void
  const earlyReady = new Promise<void>((resolve) => {
    resolveEarlyReady = resolve
  })
  const failOpen = new Promise<void>((resolve) => {
    resolveFailOpen = resolve
  })
  const reportError = (error: unknown): void => {
    try {
      onError(error)
    } catch (reportingError) {
      console.error(`[${label}] startup error reporter failed:`, reportingError)
    }
  }
  const ready = Promise.resolve()
    .then<StartupServiceStart>(() => start(abortController.signal))
    .then((startup) => {
      if (isAgentHookServerStartup(startup)) {
        void startup.statusCacheHydrationReady.then(resolveEarlyReady, resolveEarlyReady)
        return startup.ready
      }
      return startup
    })
    .catch((error) => {
      if (!reportedTimeout) {
        reportError(error)
      }
      resolveEarlyReady()
    })
    .finally(() => {
      resolveEarlyReady()
    })
  const settledReady = Promise.race([ready, failOpen])
    .finally(() => {
      settled = true
      resolveEarlyReady()
    })

  return {
    ready: settledReady,
    earlyReady,
    reportTimeout: () => {
      if (settled || reportedTimeout) {
        return
      }
      reportedTimeout = true
      abortController.abort()
      reportError(new Error(`${label} startup timed out`))
      resolveFailOpen()
    }
  }

  function isAgentHookServerStartup(
    startup: StartupServiceStart
  ): startup is AgentHookServerStartup {
    return (
      typeof startup === 'object' &&
      startup !== null &&
      'statusCacheHydrationReady' in startup
    )
  }
}

/**
 * Starts the services that must be ready before restored terminal panes mount.
 */
export function startFirstWindowStartupServices({
  startDaemonPtyProvider,
  startAgentHookServer,
  onDaemonError,
  onAgentHookServerError
}: FirstWindowStartupServices): FirstWindowStartupServicesResult {
  // Why: daemon startup and hook-server binding are independent, but both gate
  // restored terminals; run them together so cold-start latency is max(), not sum().
  // The first window fails open quickly so the user sees the app; the local PTY
  // gate waits for the services themselves (a slow daemon must not flip spawns
  // to the non-restorable LocalPtyProvider fallback) and only fails open at the
  // hard cap, which also aborts the services so a late daemon swap cannot
  // strand any fallback PTYs that spawn after the gate opens.
  const daemon = startService('daemon PTY provider', startDaemonPtyProvider, onDaemonError)
  const hooks = startService('agent hook server', startAgentHookServer, onAgentHookServerError)
  const allServicesReady = Promise.all([daemon.ready, hooks.ready]).then(() => undefined)
  // Why separate: snapshot replay only needs the hook server's durable cache
  // phase; listener binding must not inherit daemon or first-window readiness.
  const agentHookStatusCacheHydrationReady = hooks.earlyReady
  let windowTimeout: ReturnType<typeof setTimeout> | null = null
  let failOpenTimeout: ReturnType<typeof setTimeout> | null = null
  const servicesSettled = allServicesReady.finally(() => {
    if (windowTimeout) {
      clearTimeout(windowTimeout)
    }
    if (failOpenTimeout) {
      clearTimeout(failOpenTimeout)
    }
  })
  const failOpenReady = new Promise<void>((resolve) => {
    failOpenTimeout = setTimeout(() => {
      daemon.reportTimeout()
      hooks.reportTimeout()
      resolve()
    }, LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
  })
  const firstWindowReady = Promise.race([
    servicesSettled,
    new Promise<void>((resolve) => {
      windowTimeout = setTimeout(resolve, FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
    })
  ])
  const localPtyReady = Promise.race([servicesSettled, failOpenReady])
  // Why: destructive routing only needs daemon authority. A stalled optional
  // hook server must not hold terminal close for the full fail-open window.
  const localPtyProviderReady = Promise.race([daemon.ready, failOpenReady])

  return {
    firstWindowReady,
    localPtyReady,
    localPtyProviderReady,
    agentHookStatusCacheHydrationReady
  }
}
