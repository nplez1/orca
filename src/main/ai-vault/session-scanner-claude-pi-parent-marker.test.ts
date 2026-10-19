import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { peekSessionParseCacheEntry } from './session-parse-cache-store'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const PARENT_PI_SESSION_ID = '01a11ec4-f087-720f-8e54-a0af548dcadb'

type ClaudeTranscriptSpec = {
  stem: string
  sessionId: string
  timestamp: string
}

/** A `claude --print` child: an ordinary root transcript, indistinguishable in content. */
async function writeClaudeTranscript(
  projectDir: string,
  spec: ClaudeTranscriptSpec
): Promise<string> {
  const filePath = join(projectDir, `${spec.stem}.jsonl`)
  await writeJsonlFile(filePath, [
    {
      type: 'user',
      sessionId: spec.sessionId,
      timestamp: spec.timestamp,
      cwd: '/repo/app',
      message: { role: 'user', content: 'Map the scanner internals' }
    }
  ])
  return filePath
}

/** The marker Orca's hook listener drops beside the transcript once it is attributed. */
async function writePiParentMarker(transcriptPath: string, marker: unknown): Promise<void> {
  const markerPath = `${transcriptPath.slice(0, -'.jsonl'.length)}.pi-parent.json`
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, typeof marker === 'string' ? marker : JSON.stringify(marker))
}

function rowFor(sessions: AiVaultSession[], sessionId: string): AiVaultSession {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  expect(session, `expected a scanned row for ${sessionId}`).toBeDefined()
  if (!session) {
    throw new Error(`no scanned row for ${sessionId}`)
  }
  return session
}

describe('scanAiVaultSessions — Claude pi-parent marker', () => {
  it('nests a Claude transcript whose marker names a parent pi session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-parent-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-repo-app')

    const childPath = await writeClaudeTranscript(projectDir, {
      stem: 'child-uuid',
      sessionId: 'child-uuid',
      timestamp: '2026-10-01T00:00:00.000Z'
    })
    await writePiParentMarker(childPath, {
      type: 'orca-pi-claude-subagent',
      version: 1,
      parentSessionId: PARENT_PI_SESSION_ID,
      parentTranscriptPath: '/home/ada/.pi/agent/sessions/parent.jsonl',
      runId: 'run-1',
      writtenAt: 1792370000000
    })
    // A Claude session a person opened directly, beside it.
    await writeClaudeTranscript(projectDir, {
      stem: 'root-uuid',
      sessionId: 'root-uuid',
      timestamp: '2026-10-01T00:00:01.000Z'
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(rowFor(result.sessions, 'child-uuid').subagent).toEqual({
      parentSessionId: PARENT_PI_SESSION_ID,
      agentType: null,
      status: null
    })
    expect(rowFor(result.sessions, 'root-uuid').subagent).toBeNull()
  })

  it('leaves the row top-level when the marker is malformed, mistyped, or names no parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-parent-invalid-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-repo-app')

    const cases: { stem: string; timestamp: string; marker: unknown }[] = [
      { stem: 'truncated', timestamp: '2026-10-01T00:00:00.000Z', marker: '{"type":"orca-pi-' },
      {
        stem: 'wrong-type',
        timestamp: '2026-10-01T00:00:01.000Z',
        marker: { type: 'orca-pi-something-else', parentSessionId: PARENT_PI_SESSION_ID }
      },
      {
        stem: 'no-parent',
        timestamp: '2026-10-01T00:00:02.000Z',
        marker: { type: 'orca-pi-claude-subagent', parentSessionId: '   ' }
      },
      // A marker that parses to a scalar rather than an object.
      { stem: 'scalar', timestamp: '2026-10-01T00:00:03.000Z', marker: '"orca-pi-claude-subagent"' }
    ]
    for (const testCase of cases) {
      const transcriptPath = await writeClaudeTranscript(projectDir, {
        stem: testCase.stem,
        sessionId: testCase.stem,
        timestamp: testCase.timestamp
      })
      await writePiParentMarker(transcriptPath, testCase.marker)
    }

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    for (const testCase of cases) {
      expect(rowFor(result.sessions, testCase.stem).subagent).toBeNull()
    }
  })

  it('picks the marker up on the next scan when it lands after the row was cached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-parent-late-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-repo-app')
    const childPath = await writeClaudeTranscript(projectDir, {
      stem: 'child-uuid',
      sessionId: 'child-uuid',
      timestamp: '2026-10-01T00:00:00.000Z'
    })

    const before = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(rowFor(before.sessions, 'child-uuid').subagent).toBeNull()
    // The row is cached, so the transcript's own mtime+size cannot rescue it:
    // only the marker's stat can invalidate this entry.
    expect(peekSessionParseCacheEntry(childPath)?.session?.subagent ?? null).toBeNull()

    await writePiParentMarker(childPath, {
      type: 'orca-pi-claude-subagent',
      version: 1,
      parentSessionId: PARENT_PI_SESSION_ID
    })

    const after = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const nested = rowFor(after.sessions, 'child-uuid')
    expect(nested.subagent).toEqual({
      parentSessionId: PARENT_PI_SESSION_ID,
      agentType: null,
      status: null
    })
    // Invalidation re-finalizes the fold; it does not lose what the transcript said.
    expect(nested.messageCount).toBe(1)
  })
})
