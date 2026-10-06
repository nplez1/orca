import { assertFileMutationOwnershipCapability } from '../../../../shared/file-mutation-ownership'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { WebRuntimeEnvelopeCaller, WebRuntimeResultCaller } from './web-runtime-calls'
import {
  getClientForEnvironment,
  requireActiveEnvironment,
  requireActiveEnvironmentOrNull,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse,
  webRuntimeState
} from './web-runtime-session'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'

/**
 * Binds runtime calls to the pairing that was active when the session was captured. A paired web
 * client can be re-paired mid-flight, so every queued call re-asserts that the client it was
 * built for is still the active one before and after it runs.
 */
export function captureWebFileMutationSession(): {
  resolveFilePath: (filePath: string) => Promise<Awaited<ReturnType<typeof resolveRuntimeFilePath>>>
  assertMutationSupported: () => Promise<void>
  callRuntimeResult: WebRuntimeResultCaller
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
} {
  const environment = requireActiveEnvironment()
  const client = getClientForEnvironment(environment)
  const assertCurrent = (): void => {
    if (
      webRuntimeState.activeClient !== client ||
      requireActiveEnvironmentOrNull()?.id !== environment.id
    ) {
      throw new Error('Runtime pairing changed; refresh and try again')
    }
  }
  const callBoundRuntimeEnvelope: WebRuntimeEnvelopeCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<RuntimeRpcResponse<TResult>> => {
    assertCurrent()
    const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
      assertCurrent()
      return client.call(method, params, { timeoutMs })
    })
    assertCurrent()
    updateEnvironmentFromResponse(environment, response)
    return response as RuntimeRpcResponse<TResult>
  }
  const callBoundRuntimeResult: WebRuntimeResultCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> => {
    const response = await callBoundRuntimeEnvelope<TResult>(method, params, timeoutMs)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  }
  return {
    resolveFilePath: (filePath) =>
      resolveRuntimeFilePath(
        filePath,
        undefined,
        callBoundRuntimeResult,
        callBoundRuntimeEnvelope,
        false,
        environment.id
      ),
    assertMutationSupported: async () => {
      assertFileMutationOwnershipCapability(
        await callBoundRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
      )
    },
    callRuntimeResult: callBoundRuntimeResult,
    getSshState: async (targetId) =>
      (
        await callBoundRuntimeResult<{ state: SshConnectionState | null }>('ssh.getState', {
          targetId
        })
      ).state
  }
}
