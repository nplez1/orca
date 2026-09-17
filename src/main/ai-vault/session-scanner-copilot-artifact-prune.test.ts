import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const SESSION_ID = 'b2c3d4e5-2222-4333-8444-555566667777'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Copilot session-directory pruning', () => {
  it('lists only events.jsonl, not stray .jsonl artifacts in the session dir', async () => {
    // A Copilot session dir carries checkpoints/, rewind-snapshots/, files/ and
    // research/ beside events.jsonl. Walking all of them costs a readdir per
    // artifact tree per session and lists any .jsonl inside as its own session.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-copilot-prune-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionDir = join(roots.copilotSessionsDir, SESSION_ID)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'events.jsonl'),
      jsonLines([
        {
          type: 'session.start',
          data: {
            sessionId: SESSION_ID,
            startTime: '2026-05-01T10:00:00.000Z',
            context: { cwd: '/repo/app' }
          },
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        {
          type: 'user.message',
          data: { transformedContent: 'Real Copilot session' },
          timestamp: '2026-05-01T10:00:01.000Z'
        }
      ])
    )

    const artifacts = [
      join(sessionDir, 'files', 'artifact.jsonl'),
      join(sessionDir, 'research', 'notes.jsonl'),
      join(sessionDir, 'checkpoints', 'index.jsonl')
    ]
    for (const artifact of artifacts) {
      await mkdir(dirname(artifact), { recursive: true })
      await writeFile(
        artifact,
        jsonLines([
          {
            type: 'user.message',
            data: { transformedContent: 'Not a session' },
            timestamp: '2026-05-01T10:00:02.000Z'
          }
        ])
      )
    }

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
  })
})
