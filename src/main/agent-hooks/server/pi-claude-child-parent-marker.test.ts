import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writePiClaudeChildParentMarker } from './pi-claude-child-parent-marker'
import { piClaudeParentMarkerPath } from '../../../shared/pi-claude-parent-marker'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

const CONVERSATION = 'child-conversation'

function childLink(
  transcriptPath: string,
  providerSession = CONVERSATION
): NonNullable<AgentHookEventPayload['piClaudeChildParent']> {
  return { runId: 'run-1', providerSession, transcriptPath }
}

/** The row the pane already holds, which is where the parent session comes from. */
function ownerRow(): EnrichedAgentHookEventPayload {
  const row: EnrichedAgentHookEventPayload = {
    paneKey: 'tab-1:pane-1',
    source: 'pi',
    connectionId: null,
    receivedAt: 0,
    stateStartedAt: 0,
    providerSession: {
      key: 'session_id',
      id: 'pi-parent-session',
      transcriptPath: '/tmp/pi-parent-session.jsonl'
    },
    payload: { state: 'working', prompt: 'delegate', agentType: 'pi' }
  }
  return row
}

describe('the parent marker beside a claude child transcript', () => {
  let dir: string
  let transcript: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `orca-pi-claude-marker-${process.pid}-`))
    transcript = join(dir, `${CONVERSATION}.jsonl`)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the transcript it describes next to it', () => {
    expect(piClaudeParentMarkerPath('/tmp/claude-projects/project/abc.jsonl')).toBe(
      '/tmp/claude-projects/project/abc.pi-parent.json'
    )
  })

  it('records which pi session and run the conversation belongs to', async () => {
    writePiClaudeChildParentMarker(childLink(transcript), 'tab-1:pane-1', ownerRow(), 1792)

    const written = JSON.parse(await readFile(piClaudeParentMarkerPath(transcript), 'utf8'))
    expect(written).toMatchObject({
      type: 'orca-pi-claude-subagent',
      version: 1,
      parentSessionId: 'pi-parent-session',
      parentTranscriptPath: '/tmp/pi-parent-session.jsonl',
      runId: 'run-1',
      parentPaneKey: 'tab-1:pane-1',
      writtenAt: 1792
    })
  })

  it('rewrites nothing when it already says the same thing', async () => {
    const path = piClaudeParentMarkerPath(transcript)
    writePiClaudeChildParentMarker(childLink(transcript), 'tab-1:pane-1', ownerRow(), 1792)
    const first = await readFile(path, 'utf8')
    // The child posts dozens of events; only the first may touch the disk.
    writePiClaudeChildParentMarker(childLink(transcript), 'tab-1:pane-1', ownerRow(), 4000)
    expect(await readFile(path, 'utf8')).toBe(first)
  })

  it('writes nothing when the pane has no pi session to attribute to', async () => {
    writePiClaudeChildParentMarker(childLink(transcript), 'tab-1:pane-1', undefined, 1792)
    await expect(readFile(piClaudeParentMarkerPath(transcript), 'utf8')).rejects.toThrow()
  })

  it('writes nothing when the post names a different conversation than its transcript', async () => {
    // Why: the marker decides which session the transcript is nested under, so a post that lies
    // about which file it describes would attribute somebody else's conversation.
    writePiClaudeChildParentMarker(
      childLink(transcript, 'some-other-conversation'),
      'tab-1:pane-1',
      ownerRow(),
      1792
    )
    await expect(readFile(piClaudeParentMarkerPath(transcript), 'utf8')).rejects.toThrow()
  })

  it('never throws over an unwritable location', () => {
    expect(() =>
      writePiClaudeChildParentMarker(
        childLink(join(dir, 'missing-dir', `${CONVERSATION}.jsonl`)),
        'tab-1:pane-1',
        ownerRow(),
        1792
      )
    ).not.toThrow()
  })

  it('overwrites a marker that names a different run', async () => {
    const path = piClaudeParentMarkerPath(transcript)
    await writeFile(path, JSON.stringify({ type: 'orca-pi-claude-subagent', runId: 'stale' }))
    writePiClaudeChildParentMarker(childLink(transcript), 'tab-1:pane-1', ownerRow(), 1792)
    expect(JSON.parse(await readFile(path, 'utf8')).runId).toBe('run-1')
  })
})
