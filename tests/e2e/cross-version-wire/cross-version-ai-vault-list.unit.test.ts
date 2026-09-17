// Cross-version coverage for the Agent Session History list, paired the same way
// the terminal and structured-agent-session harnesses are: current code against a
// real published release.
//
// The list moved onto the SQLite index, so the risk is that the row projection
// drifted while the wire shape did not. This pins the shape the last released
// host and client speak in both directions — see
// docs/reference/remote-wire-compatibility.md.

import { beforeAll, describe, expect, it } from 'vitest'
import { parseAiVaultListResult } from '../../../src/main/ai-vault/session-list-result-validation'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

type ListParser = (value: unknown) => {
  sessions: { sessionId: string; resumeCommand: string; executionHostId: string }[]
  issues: unknown[]
  scannedAt: string
}

let parseBaselineListResult: ListParser

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const SCANNED_AT = '2026-07-27T00:00:00.000Z'

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const module = await importReleaseCheckoutModule(
    checkout,
    '/src/main/ai-vault/session-list-result-validation.ts'
  )
  const parse = module.parseAiVaultListResult
  if (typeof parse !== 'function') {
    throw new Error(`Release checkout ${checkout.ref} publishes no list-result parser`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the released module exports the same parser under the same name, and its signature cannot be imported from a checkout the test extracts at runtime.
  parseBaselineListResult = parse as ListParser
}, SUITE_TIMEOUT_MS)

function sessionRow(sessionId: string): Record<string, unknown> {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId,
    title: `Session ${sessionId}`,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

describe('cross-version Agent Session History list', () => {
  it('reads the current host row shape with the released parser', () => {
    const parsed = parseBaselineListResult({
      sessions: [sessionRow('session-1')],
      issues: [],
      scannedAt: SCANNED_AT
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]).toMatchObject({
      executionHostId: 'local',
      sessionId: 'session-1',
      resumeCommand: 'codex resume session-1'
    })
  })

  it('reads the released host row shape with the current parser', () => {
    // A released host also adds a scan issue in the shape it shipped with.
    const parsed = parseAiVaultListResult({
      sessions: [sessionRow('session-1')],
      issues: [
        { agent: 'codex', kind: 'scope', path: '/tmp/sessions', message: 'permission denied' }
      ],
      scannedAt: SCANNED_AT
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.sessionId).toBe('session-1')
    expect(parsed.issues).toEqual([
      expect.objectContaining({ kind: 'scope', message: 'permission denied' })
    ])
  })
})
