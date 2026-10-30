import { randomUUID } from 'node:crypto'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { readRetryRequestFlag } from '../../retry-request-flag'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'
import { compatibilityCommandFallbackParams } from './runtime-compatibility'

const MAX_UNAVAILABLE_RETRY_DELAY_MS = 15_000

export async function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string },
  unavailableRetryMs = 0
) {
  // Reuse one request id so retries replay the mutation instead of applying it twice.
  const requestId =
    readRetryRequestFlag(flags) ?? (unavailableRetryMs > 0 ? randomUUID() : undefined)
  const deadline = Date.now() + unavailableRetryMs
  let sentError: RuntimeClientError | undefined
  let payload = params
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_UNAVAILABLE_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, payload, {
            ...options,
            orchestrationRequestId: requestId
          })
        : options
          ? await client.call<TResult>(method, payload, options)
          : await client.call<TResult>(method, payload)
    } catch (error) {
      // Why here: the peer-CLI fields are validated before any handler runs, so a host built
      // before the Orca NP rename refuses the whole call as invalid params. The same call
      // without them is what that host accepts, so degrade once instead of failing the ask.
      const degraded = compatibilityCommandFallbackParams(error, payload)
      if (degraded) {
        payload = degraded
        continue
      }
      const unavailable =
        error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
      if (carriesRequestId(error)) {
        sentError = error
      }
      if (!unavailable || Date.now() + delayMs > deadline) {
        // A later failure may lack the request id even though an earlier attempt landed.
        throw orchestrationMutationRecoveryError(
          carriesRequestId(error) ? error : (sentError ?? error)
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function carriesRequestId(error: unknown): error is RuntimeClientError {
  const data: unknown = error instanceof RuntimeClientError ? error.data : undefined
  return (
    typeof data === 'object' &&
    data !== null &&
    'orchestrationRequestId' in data &&
    typeof data.orchestrationRequestId === 'string'
  )
}
