/** Shared setup for the restart-watch suites: an endpoint served from the on-disk file, as a real
 *  pane's env points it there, plus the "restart" that rewrites it. */
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Why: Orca mints a new hook token (and usually a new port) on every start, so a restarted Orca is
// an endpoint change to the agent already running in the pane it restored that agent's row from.
export const ENDPOINT_FILE = '/orca-np/agent-hooks/endpoint.env'
export const WATCH_MS = 2000
export const WSL_CURL_PATH = '/mnt/c/Windows/System32/curl.exe'

export function endpointFile(port: string, token: string): string {
  return [
    `ORCA_AGENT_HOOK_PORT=${port}`,
    `ORCA_AGENT_HOOK_TOKEN=${token}`,
    'ORCA_AGENT_HOOK_ENV=production',
    'ORCA_AGENT_HOOK_VERSION=1'
  ].join('\n')
}

export function harnessWithEndpoint(
  port: string,
  token: string,
  extra: { kind?: PiAgentKind; env?: Record<string, string>; curlExitCode?: number | null } = {}
) {
  return createAgentStatusExtensionHarness({
    kind: extra.kind ?? 'pi',
    env: { ORCA_AGENT_HOOK_ENDPOINT: ENDPOINT_FILE, ...extra.env },
    ...(extra.curlExitCode !== undefined ? { curlExitCode: extra.curlExitCode } : {}),
    statSync: () => ({ mtimeMs: 1, size: 100, ino: 1 }),
    readFileSync: () => endpointFile(port, token)
  })
}

type Harness = ReturnType<typeof harnessWithEndpoint>

/** Rewrite the endpoint file the way a restarted Orca does: same path, new identity. */
export function restartOrca(harness: Harness, port: string, token: string, statKey = 2): void {
  harness.fsMock.statSync.mockImplementation(() => ({
    mtimeMs: statKey,
    size: 100 + statKey,
    ino: statKey
  }))
  harness.fsMock.readFileSync.mockImplementation(() => endpointFile(port, token))
}

/** The argv of the last curl.exe the WSL bridge spawned. */
export function curlArgv(harness: Harness): string[] {
  const argv: unknown = harness.spawnMock.mock.calls.at(-1)?.[1]
  return Array.isArray(argv) ? argv.filter((arg): arg is string => typeof arg === 'string') : []
}

export function curlUrl(harness: Harness): string | undefined {
  return curlArgv(harness).findLast((arg) => arg.startsWith('http://'))
}

/** Fail every curl the bridge spawns until one targeting `healthyUrl` lands, then acknowledge it. */
export async function resolveCurlCandidates(
  harness: Harness,
  healthyUrl: string,
  advance: (ms: number) => Promise<unknown>
): Promise<void> {
  let closed = 0
  while (closed < harness.spawnedChildren.length) {
    const child = harness.spawnedChildren[closed]
    const argv: unknown = harness.spawnMock.mock.calls[closed]?.[1]
    const url = Array.isArray(argv)
      ? argv.findLast((arg): arg is string => typeof arg === 'string' && arg.startsWith('http://'))
      : undefined
    closed += 1
    child?.emit('close', url === healthyUrl ? 0 : 7)
    await advance(0)
    if (url === healthyUrl) {
      return
    }
  }
}

export const working = { isIdle: () => false }
