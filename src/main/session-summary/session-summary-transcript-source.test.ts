import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../ai-vault/transcripts/session-transcript-record-budget'

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

  // Acceptance 3: a transcript past the old ceiling folds rather than failing. The budget is a
  // diagnostic now, which is what makes the 24 MB refusal unnecessary rather than merely raisable.
  it('folds past the retained-text budget instead of refusing', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    await writeFile(transcriptPath, piTranscript('a message', 'a reply'))
    const { readSessionSummaryEventsFromFile } = await loadSource()

    const read = await readSessionSummaryEventsFromFile({
      filePath: transcriptPath,
      parser: 'pi',
      signal: signal(),
      // The budget in production is 24 MB of text; the shape is the same at a few bytes.
      maxRetainedBytes: 4
    })

    expect(read?.events.map((event) => event.text)).toEqual(['a message', 'a reply'])
    expect(read?.overRetainedBudget).toBe(true)
    expect(read?.retainedBytes).toBeGreaterThan(4)
  })

  // Every tool event reaches the fold as a one-line record, so a 900-line read never enters the
  // event array as 900 lines of text.
  it('digests tool events instead of retaining their bodies', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, 'claude-1.jsonl')
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'read the file' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-1',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: Array.from({ length: 900 }, (_, index) => `line ${index}`).join('\n')
              }
            ]
          }
        })
      ].join('\n')
    )
    const { readSessionSummaryEventsFromFile } = await loadSource()

    const read = await readSessionSummaryEventsFromFile({
      filePath: transcriptPath,
      parser: 'claude',
      signal: signal()
    })

    expect(read?.events.map((event) => event.text)).toEqual([
      'read the file',
      'Read /repo/a.ts',
      'Read /repo/a.ts · 900 lines / 7.8 KB · ok'
    ])
  })

  // Acceptance 4: a record the reader could not decode is a named gap, not a silence — and it never
  // becomes an event, because a skipped record has no message index.
  it('names a record the reader skipped instead of losing it silently', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, 'claude-gap.jsonl')
    const kept = `${JSON.stringify({
      type: 'user',
      sessionId: 'claude-gap',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'before the hole' }
    })}\n`
    const oversized = 'x'.repeat(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1)
    const after = `${JSON.stringify({
      type: 'user',
      sessionId: 'claude-gap',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'after the hole' }
    })}\n`
    await writeFile(transcriptPath, `${kept}${oversized}\n${after}`)
    const { readSessionSummaryEventsFromFile } = await loadSource()

    const read = await readSessionSummaryEventsFromFile({
      filePath: transcriptPath,
      parser: 'claude',
      signal: signal()
    })

    expect(read?.events.map((event) => event.text)).toEqual(['before the hole', 'after the hole'])
    expect(read?.gaps).toHaveLength(1)
    expect(read?.gaps[0].afterEventIndex).toBe(1)
    expect(read?.gaps[0].text).toContain('Skipped 1 oversized transcript record')
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

  // Why: the consumer registry is process-wide and consumers used to accept any read whose path
  // matched, so a second fold of one session enlisted the first one's consumer — its collection then
  // held both streams interleaved and the fold's indexes pointed at the wrong messages.
  it('keeps two concurrent folds of one file apart', async () => {
    const dir = await tempDir()
    const transcriptPath = join(dir, '2026-01-01T00-00-00-000Z_pi-session-1.jsonl')
    await writeFile(transcriptPath, piTranscript('Add a sticky-note icon', 'Icon replaced.'))
    const { readSessionSummaryTranscriptEvents } = await loadSource()
    const identity = {
      agentType: 'pi' as const,
      providerSession: { key: 'session_id' as const, id: 'pi-session-1', transcriptPath }
    }

    const [first, second] = await Promise.all([
      readSessionSummaryTranscriptEvents({ identity, signal: signal() }),
      readSessionSummaryTranscriptEvents({ identity, signal: signal() })
    ])

    expect(first?.events.map((event) => event.text)).toEqual([
      'Add a sticky-note icon',
      'Icon replaced.'
    ])
    expect(second?.events.map((event) => event.text)).toEqual([
      'Add a sticky-note icon',
      'Icon replaced.'
    ])
  })
})
