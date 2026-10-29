import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'

/**
 * Why: the fold reads provider transcripts in the Electron main process, so a pane close has to
 * reach the read. `parseAgentSessionFile` used to drop its signal for these four agents, and closing
 * a pane then left a whole transcript streaming.
 */

const CLAUDE_LINE = JSON.stringify({
  type: 'user',
  sessionId: 'session-1',
  timestamp: '2026-05-01T10:00:00.000Z',
  cwd: '/tmp/claude',
  message: { role: 'user', content: 'ask' }
})

const CODEX_LINE = JSON.stringify({
  timestamp: '2026-05-01T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'session-1', cwd: '/tmp/codex' }
})

const PI_LINE = JSON.stringify({
  type: 'session',
  id: 'session-1',
  cwd: '/tmp/pi',
  timestamp: '2026-05-01T10:00:00.000Z'
})

const COPILOT_LINE = JSON.stringify({
  type: 'session.start',
  data: { sessionId: 'session-1', context: { cwd: '/tmp/copilot' } },
  timestamp: '2026-05-01T10:00:00.000Z'
})

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

async function transcriptFor(agent: AiVaultAgent, body: string): Promise<SessionFileCandidate> {
  temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'orca-parser-signal-'))
  const path = join(temporaryDirectory, `${agent}-session.jsonl`)
  await writeFile(path, `${body}\n`)
  const file: FileWithMtime = {
    path,
    mtimeMs: 1,
    modifiedAt: '2026-05-01T10:00:00.000Z',
    sizeBytes: body.length
  }
  return { agent, file, codexHome: null }
}

describe('parseAgentSessionFile signal propagation', () => {
  it.each([
    ['claude' as const, CLAUDE_LINE],
    ['codex' as const, CODEX_LINE],
    ['pi' as const, PI_LINE],
    ['copilot' as const, COPILOT_LINE]
  ])('stops a %s read at the caller signal', async (agent, body) => {
    const candidate = await transcriptFor(agent, body)

    await expect(
      parseAgentSessionFile(
        candidate,
        'linux',
        undefined,
        AbortSignal.abort(new Error('pane closed'))
      )
    ).rejects.toThrow()
  })

  it('still reads the same transcript when the signal is un-aborted', async () => {
    const candidate = await transcriptFor('claude', CLAUDE_LINE)

    await expect(
      parseAgentSessionFile(candidate, 'linux', undefined, new AbortController().signal)
    ).resolves.toMatchObject({ agent: 'claude' })
  })
})
