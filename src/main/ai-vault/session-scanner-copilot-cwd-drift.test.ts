import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { filterAiVaultSessions } from '../../shared/ai-vault-session-filters'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const SESSION_ID = 'a1b2c3d4-1111-4222-8333-444455556666'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Copilot stores one directory per session: <session-state>/<uuid>/events.jsonl.
async function writeCopilotSession(
  copilotSessionsDir: string,
  sessionId: string,
  records: unknown[]
): Promise<void> {
  const sessionDir = join(copilotSessionsDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'events.jsonl'), jsonLines(records))
}

function sessionStart(context: Record<string, unknown> | null): unknown {
  return {
    type: 'session.start',
    data: {
      sessionId: SESSION_ID,
      startTime: '2026-05-01T10:00:00.000Z',
      ...(context ? { context } : {})
    },
    timestamp: '2026-05-01T10:00:00.000Z'
  }
}

function folderTrust(folder: string, timestamp: string): unknown {
  return {
    type: 'session.info',
    data: {
      infoType: 'folder_trust',
      message: `Folder ${folder} has been added to trusted folders.`
    },
    timestamp
  }
}

const USER_MESSAGE = {
  type: 'user.message',
  data: { transformedContent: 'Copilot title' },
  timestamp: '2026-05-01T10:00:10.000Z'
}

describe('scanAiVaultSessions — Copilot session cwd', () => {
  it('keeps the start directory when a later folder_trust names another folder', async () => {
    // Regression: the parser took the *last* folder_trust message as the cwd, so
    // a session that trusted another folder mid-run was attributed to that
    // folder's workspace and vanished from the one it actually ran in.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-copilot-cwd-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeCopilotSession(roots.copilotSessionsDir, SESSION_ID, [
      sessionStart({ cwd: '/repo/app', branch: 'main' }),
      folderTrust('/repo/other', '2026-05-01T10:00:05.000Z'),
      USER_MESSAGE
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const copilot = result.sessions.find((session) => session.agent === 'copilot')
    expect(copilot).toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/repo/app',
      resumeCommand: `cd '/repo/app' && copilot --resume='${SESSION_ID}'`
    })

    // The workspace-scoped panel narrows on cwd, so this is the user-visible
    // consequence: listed under /repo/app, absent from /repo/other.
    const filters = {
      query: '',
      agents: AI_VAULT_AGENTS,
      scope: 'workspace' as const,
      sort: 'updated' as const,
      hideEmptySessions: false
    }
    const sessions = copilot ? [copilot] : []
    expect(
      filterAiVaultSessions(sessions, { ...filters, activeWorktreePaths: ['/repo/app'] })
    ).toHaveLength(1)
    expect(
      filterAiVaultSessions(sessions, { ...filters, activeWorktreePaths: ['/repo/other'] })
    ).toHaveLength(0)
  })

  it('falls back to folder_trust for builds that predate context.cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-copilot-legacy-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeCopilotSession(roots.copilotSessionsDir, SESSION_ID, [
      sessionStart(null),
      folderTrust('/repo/legacy', '2026-05-01T10:00:05.000Z'),
      USER_MESSAGE
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.find((session) => session.agent === 'copilot')).toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/repo/legacy'
    })
  })

  it('takes the first folder_trust when the legacy transcript names several', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-copilot-first-trust-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeCopilotSession(roots.copilotSessionsDir, SESSION_ID, [
      sessionStart(null),
      folderTrust('/repo/first', '2026-05-01T10:00:05.000Z'),
      folderTrust('/repo/second', '2026-05-01T10:00:06.000Z'),
      USER_MESSAGE
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.find((session) => session.agent === 'copilot')).toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/repo/first'
    })
  })
})
