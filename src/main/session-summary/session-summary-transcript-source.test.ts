import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_TRANSCRIPT_MAX_BYTES } from './session-summary-transcript-source'

/**
 * Which provider transcripts the fold can read.
 *
 * Pi and Copilot are the agents this file exists for: neither is a native-chat
 * transcript agent, so before this the fold resolved no path and the pane read
 * "no readable transcript" for every one of their sessions.
 */

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-summary-source-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Pi writes a `session` record then `message` records whose content is blocks. */
function piTranscript(prompt: string, reply: string): string {
  return [
    JSON.stringify({
      type: 'session',
      id: 'pi-session-1',
      cwd: '/tmp/project',
      timestamp: '2026-01-01T00:00:00.000Z'
    }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] }
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: reply }] }
    })
  ].join('\n')
}

/** Copilot writes one event object per line, payload under `data`. */
function copilotTranscript(prompt: string, reply: string): string {
  return [
    JSON.stringify({
      type: 'session.start',
      data: { sessionId: 'copilot-session-1', context: { cwd: '/tmp/project' } },
      timestamp: '2026-01-01T00:00:00.000Z'
    }),
    JSON.stringify({
      type: 'user.message',
      data: { content: prompt },
      timestamp: '2026-01-01T00:00:01.000Z'
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: { content: reply },
      timestamp: '2026-01-01T00:00:02.000Z'
    })
  ].join('\n')
}

/**
 * Copilot's sessions root is a module-level constant read from the environment,
 * so the stub has to land before the module graph is evaluated.
 */
async function loadSource() {
  vi.resetModules()
  return await import('./session-summary-transcript-source.js')
}

const signal = (): AbortSignal => new AbortController().signal

describe('readSessionSummaryTranscriptEvents', () => {
  it('reads a Pi session from the file its hook reports', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    await writeFile(transcriptPath, piTranscript('Add a sticky-note icon', 'Icon replaced.'))
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath }
      },
      signal: signal()
    })

    expect(events?.events.map((event) => event.text)).toEqual([
      'Add a sticky-note icon',
      'Icon replaced.'
    ])
  })

  it('reads a Copilot session from its session-state directory', async () => {
    const home = await tempDir()
    vi.stubEnv('COPILOT_HOME', home)
    const sessionDir = join(home, 'session-state', 'copilot-session-1')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'events.jsonl'),
      copilotTranscript('Why is the pane empty?', 'The transcript never resolved.')
    )
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'copilot',
        providerSession: { key: 'session_id', id: 'copilot-session-1' }
      },
      signal: signal()
    })

    expect(events?.events.map((event) => event.text)).toEqual([
      'Why is the pane empty?',
      'The transcript never resolved.'
    ])
  })

  it('never joins a Copilot session id onto the sessions root', async () => {
    const home = await tempDir()
    vi.stubEnv('COPILOT_HOME', home)
    // A transcript the traversal would reach if the id were joined unchecked.
    await mkdir(join(home, 'session-state'), { recursive: true })
    await writeFile(join(home, 'session-state', 'events.jsonl'), copilotTranscript('x', 'y'))
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'copilot',
        providerSession: { key: 'session_id', id: '../' }
      },
      signal: signal()
    })

    expect(events).toBeNull()
  })

  it('returns null when the hook path is not a readable file', async () => {
    const dir = await tempDir()
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'pi',
        // A directory: resolvable, but not a transcript.
        providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath: dir }
      },
      signal: signal()
    })

    expect(events).toBeNull()
  })

  it('returns null for an agent whose transcript has no parser', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, 'amp-session.jsonl')
    await writeFile(transcriptPath, '{}\n')
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'amp',
        providerSession: { key: 'session_id', id: 'amp-1', transcriptPath }
      },
      signal: signal()
    })

    expect(events).toBeNull()
  })

  // Why: the fold's dispatch used to be an allowlist of three agents, so every other agent
  // reported "no readable transcript" even when its hook handed over the path it was writing.
  it('reads an agent outside the native-chat set from its hook-reported path', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, 'droid-session.jsonl')
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'system',
          session_id: 'droid-1',
          timestamp: '2026-05-01T10:09:00.000Z',
          cwd: '/tmp/droid'
        }),
        JSON.stringify({
          type: 'message',
          session_id: 'droid-1',
          timestamp: '2026-05-01T10:09:01.000Z',
          role: 'user',
          text: 'Why is the pane empty?'
        })
      ].join('\n')
    )
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const events = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'droid',
        providerSession: { key: 'session_id', id: 'droid-1', transcriptPath }
      },
      signal: signal()
    })

    expect(events?.events.map((event) => event.text)).toEqual(['Why is the pane empty?'])
  })

  it('folds from the cursor instead of collecting the events it already folded', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    await writeFile(transcriptPath, piTranscript('Add a sticky-note icon', 'Icon replaced.'))
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    const read = await readSessionSummaryTranscriptEvents({
      identity: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath }
      },
      signal: signal(),
      fromEventIndex: 1
    })

    expect(read?.events.map((event) => event.text)).toEqual(['Icon replaced.'])
    // The total still counts the skipped message: the pane's backlog is derived from it.
    expect(read?.totalEvents).toBe(2)
  })

  it('refuses an oversized local transcript instead of reading it into the main process', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    // Sparse: the size is what the cap checks, so the bytes never need to exist.
    const handle = await open(transcriptPath, 'w')
    await handle.truncate(LOCAL_TRANSCRIPT_MAX_BYTES + 1)
    await handle.close()
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    await expect(
      readSessionSummaryTranscriptEvents({
        identity: {
          agentType: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath }
        },
        signal: signal()
      })
    ).rejects.toThrow(/over 24 MB, which is too large to fold/)
  })

  it('stops a read when the caller aborts it', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    await writeFile(transcriptPath, piTranscript('Add a sticky-note icon', 'Icon replaced.'))
    const { readSessionSummaryTranscriptEvents } = await loadSource()

    await expect(
      readSessionSummaryTranscriptEvents({
        identity: {
          agentType: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath }
        },
        signal: AbortSignal.abort(new Error('pane closed'))
      })
    ).rejects.toThrow()
  })
})
