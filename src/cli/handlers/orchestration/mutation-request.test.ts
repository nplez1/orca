import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeClient } from '../../runtime-client'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'

const RETRY_MS = 120_000
const WORKER_DONE = {
  from: 'term_worker',
  subject: 'done',
  type: 'worker_done',
  payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}'
}

afterEach(async () => {
  vi.useRealTimers()
})

type CallOptions = { orchestrationRequestId?: string }

function fakeClient(respond: (attempt: number, options?: CallOptions) => unknown): {
  client: RuntimeClient
  requestIds: (string | undefined)[]
  payloads: unknown[]
} {
  const requestIds: (string | undefined)[] = []
  const payloads: unknown[] = []
  const call = vi.fn(async (_method: string, params: unknown, options?: CallOptions) => {
    requestIds.push(options?.orchestrationRequestId)
    payloads.push(params)
    return respond(requestIds.length, options)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callOrchestrationMutation only uses client.call.
  return { client: { call } as unknown as RuntimeClient, requestIds, payloads }
}

function unavailable(options?: CallOptions): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Could not connect to the running Orca app.',
    {
      orchestrationRequestId: options?.orchestrationRequestId,
      originalCommand: ['orca', 'orchestration', 'send', '--type', 'worker_done']
    }
  )
}

describe('callOrchestrationMutation peer-CLI compatibility', () => {
  const CHECK_PARAMS = {
    terminal: 'term_worker',
    unread: true,
    compatibilityCliCommand: 'orca-np'
  }

  it('retries without the peer-CLI name a pre-rename host refuses', async () => {
    // Why: that host validates the field against a closed enum before any handler runs, so the
    // whole check fails as invalid params instead of degrading to its own default command.
    const { client, payloads } = fakeClient((attempt) => {
      if (attempt === 1) {
        throw new RuntimeClientError(
          'invalid_argument',
          "Invalid enum value. Expected 'orca' | 'orca-ide' | 'orca-dev', received 'orca-np'"
        )
      }
      return { ok: true, result: 'checked' }
    })

    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.check', CHECK_PARAMS)
    ).resolves.toEqual({ ok: true, result: 'checked' })
    expect(payloads).toEqual([CHECK_PARAMS, { terminal: 'term_worker', unread: true }])
  })

  it('retries once, then reports the second refusal', async () => {
    const { client, requestIds } = fakeClient(() => {
      throw new RuntimeClientError('invalid_argument', 'Invalid params: unknown field.')
    })

    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.ask', CHECK_PARAMS)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(requestIds).toHaveLength(2)
  })

  it('does not retry a call that carried no peer-CLI name', async () => {
    const { client, requestIds } = fakeClient(() => {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one of --question or --resume.'
      )
    })

    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.ask', { question: 'hi' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(requestIds).toHaveLength(1)
  })

  it('leaves a windows launcher name out of the degraded retry too', async () => {
    const { client, payloads } = fakeClient((attempt) => {
      if (attempt === 1) {
        throw new RuntimeClientError('invalid_argument', 'Invalid enum value.')
      }
      return { ok: true, result: 'asked' }
    })

    await callOrchestrationMutation(client, new Map(), 'orchestration.ask', {
      question: 'Ship it?',
      compatibilityCliCommand: 'orca-np',
      compatibilityWindowsCommand: 'orca-np'
    })

    expect(payloads[1]).toEqual({ question: 'Ship it?' })
  })
})

describe('callOrchestrationMutation runtime_unavailable retry', () => {
  it('keeps the recovery command when the last attempt fails before its request id is attached', async () => {
    vi.useFakeTimers()
    const { client, requestIds } = fakeClient((attempt, options) => {
      throw attempt === 1
        ? unavailable(options)
        : new RuntimeClientError('runtime_unavailable', 'No runtime metadata.')
    })
    const settled = callOrchestrationMutation(
      client,
      new Map(),
      'orchestration.send',
      WORKER_DONE,
      undefined,
      RETRY_MS
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(RETRY_MS + 30_000)
    expect(await settled).toMatchObject({
      data: { recovery: { orchestrationRequestId: requestIds[0] } }
    })
  })

  // Windows cannot use this temporary Unix socket path.

  // Windows cannot use this temporary Unix socket path.
})
