import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Copied from Pi's getDefaultSessionDirPath rather than imported, so the
// fixtures stay Pi-shaped (see session-scanner-pi-scope.test.ts).
function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

const CWD = '/home/ada/orca/workspaces/orca/feature'
const PARENT_ID = '01a11ec4-f087-720f-8e54-a0af548dcadb'
const PARENT_TIMESTAMP = '2026-10-01T00:00:00.000Z'

type ChildSpec = {
  id: string
  // The header's lineage field, which Pi writes for compaction and for
  // "resume in another directory" as well as for sub-agents.
  parentSession: string
  name?: string
  preamble?: string
  userText?: string
}

async function writePiTranscript(args: {
  piSessionsDir: string
  id: string
  timestamp: string
  parentSession?: string
  records: unknown[]
}): Promise<string> {
  const filePath = join(
    args.piSessionsDir,
    piSessionDirName(CWD),
    `${args.timestamp}_${args.id}.jsonl`
  )
  await writeJsonlFile(filePath, [
    {
      type: 'session',
      version: 3,
      id: args.id,
      timestamp: args.timestamp,
      cwd: CWD,
      ...(args.parentSession ? { parentSession: args.parentSession } : {})
    },
    ...args.records
  ])
  return filePath
}

function userMessage(text: string, timestamp: string): unknown {
  return {
    type: 'message',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
}

async function writePiChild(piSessionsDir: string, spec: ChildSpec): Promise<void> {
  const timestamp = '2026-10-01T01:00:00.000Z'
  const records: unknown[] = []
  if (spec.name) {
    records.push({ type: 'session_info', timestamp, name: spec.name })
  }
  if (spec.preamble) {
    records.push({
      type: 'message',
      timestamp,
      message: { role: 'system', content: '', sections: { preamble: spec.preamble } }
    })
  }
  records.push(userMessage('task prompt', '2026-10-01T01:00:01.000Z'))
  await writePiTranscript({
    piSessionsDir,
    id: spec.id,
    timestamp,
    parentSession: spec.parentSession,
    records
  })
}

// Pi writes one session file per sub-agent, beside its parent, so the scanner
// sees them as ordinary rows. The shapes below are captured from real runs of
// the bundled pi-subagents extension.
describe('scanAiVaultSessions — Pi sub-agent transcripts', () => {
  it('marks children that declare a sub-agent identity and leaves lineage-only children alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-subagent-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    const parentPath = await writePiTranscript({
      piSessionsDir: roots.piSessionsDir,
      id: PARENT_ID,
      timestamp: PARENT_TIMESTAMP,
      records: [userMessage('fan out', '2026-10-01T00:00:01.000Z')]
    })

    // Named sub-agent: the marker real runs persist even when no system
    // message is written at all.
    await writePiChild(roots.piSessionsDir, {
      id: '01a11ec7-bda4-720f-8e54-a0b0d6d16e35',
      parentSession: parentPath,
      name: 'Explore#06356862'
    })
    // Older run: a sub-agent preamble, but the spawner's name carries no id.
    await writePiChild(roots.piSessionsDir, {
      id: '01a11ec7-bdb4-720f-8e54-a0b35bb27682',
      parentSession: parentPath,
      preamble: '<active_agent name="general-purpose"/>\n\nYou are a pi coding agent sub-agent.',
      userText: 'plain name'
    })
    // Auto-compaction: the same lineage field, but a real conversation and no
    // sub-agent declaration. Nesting it would hide the live session.
    await writePiChild(roots.piSessionsDir, {
      id: '01a11ec8-0000-720f-8e54-a0b999999999',
      parentSession: parentPath,
      userText: 'Did we fix everything?'
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })
    const byId = new Map(result.sessions.map((session) => [session.sessionId, session]))

    expect(byId.get(PARENT_ID)?.subagent).toBeNull()
    expect(byId.get('01a11ec7-bda4-720f-8e54-a0b0d6d16e35')?.subagent).toEqual({
      parentSessionId: PARENT_ID,
      agentType: 'Explore',
      status: null
    })
    expect(byId.get('01a11ec7-bdb4-720f-8e54-a0b35bb27682')?.subagent).toEqual({
      parentSessionId: PARENT_ID,
      agentType: 'general-purpose',
      status: null
    })
    expect(byId.get('01a11ec8-0000-720f-8e54-a0b999999999')?.subagent).toBeNull()
  })

  it('ignores a rename that lands after the conversation started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-pi-rename-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const id = '01a11ec9-1111-720f-8e54-a0b111111111'

    await writePiTranscript({
      piSessionsDir: roots.piSessionsDir,
      id,
      timestamp: '2026-10-02T00:00:00.000Z',
      parentSession: join(root, 'earlier.jsonl'),
      records: [
        userMessage('hello', '2026-10-02T00:00:01.000Z'),
        { type: 'session_info', timestamp: '2026-10-02T00:01:00.000Z', name: 'Notes#12345678' }
      ]
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.sessions.find((session) => session.sessionId === id)?.subagent).toBeNull()
  })
})
