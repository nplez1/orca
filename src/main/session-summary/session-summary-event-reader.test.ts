import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionSummaryEventReader } from './session-summary-event-reader'
import type { RemoteTranscriptFetch } from './session-summary-remote-transcript'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Pi's own shape: a `session` record, then `message` records with content blocks. */
function piLines(): string[] {
  return [
    JSON.stringify({
      type: 'session',
      id: 'pi-1',
      cwd: '/tmp/p',
      timestamp: '2026-01-01T00:00:00Z'
    }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2',
      timestamp: '2026-01-01T00:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }
    })
  ]
}

async function transcriptFile(lines: string[]): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-summary-events-'))
  dirs.push(dir)
  const path = join(dir, 'sess-1.jsonl')
  await writeFile(path, lines.join('\n'), 'utf8')
  return { dir, path }
}

const sshHost: SessionSummaryTranscriptHost = {
  kind: 'ssh',
  hostId: 'ssh:target-1',
  targetId: 'target-1'
}

describe('createSessionSummaryEventReader', () => {
  it('reads a local session without fetching anything', async () => {
    const file = await transcriptFile(piLines())
    const fetchSshTranscript = vi.fn(
      async (_args: {
        targetId: string
        remotePath: string
        signal: AbortSignal
      }): Promise<RemoteTranscriptFetch> => ({ kind: 'missing' })
    )
    const read = createSessionSummaryEventReader({ fetchSshTranscript })

    const events = await read({
      identity: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: file.path }
      },
      host: { kind: 'local' },
      signal: new AbortController().signal
    })

    expect(fetchSshTranscript).not.toHaveBeenCalled()
    expect(events?.events.map((event) => event.role)).toEqual(['user', 'assistant'])
  })

  // The whole point of the SSH path: the same parser over a fetched copy.
  it('parses the transcript it fetched from an SSH host', async () => {
    const fetched = await transcriptFile(piLines())
    const dispose = vi.fn(async () => {})
    const fetchSshTranscript = vi.fn(async () => ({
      kind: 'file' as const,
      path: fetched.path,
      dispose
    }))
    const read = createSessionSummaryEventReader({ fetchSshTranscript })

    const events = await read({
      identity: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/remote/sess-1.jsonl' }
      },
      host: sshHost,
      signal: new AbortController().signal
    })

    expect(fetchSshTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'target-1', remotePath: '/remote/sess-1.jsonl' })
    )
    expect(events?.events.map((event) => event.role)).toEqual(['user', 'assistant'])
    expect(dispose).toHaveBeenCalled()
  })

  it('disposes the copy even when the parse throws', async () => {
    const dispose = vi.fn()
    const read = createSessionSummaryEventReader({
      fetchSshTranscript: async () => ({
        kind: 'file' as const,
        path: join(tmpdir(), 'orca-missing-transcript-xyz.jsonl'),
        dispose
      })
    })

    await expect(
      read({
        identity: {
          agentType: 'pi',
          providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/r/x.jsonl' }
        },
        host: sshHost,
        signal: new AbortController().signal
      })
    ).rejects.toThrow()
    expect(dispose).toHaveBeenCalled()
  })

  it('reads nothing when the hook named no path', async () => {
    const fetchSshTranscript = vi.fn(
      async (_args: {
        targetId: string
        remotePath: string
        signal: AbortSignal
      }): Promise<RemoteTranscriptFetch> => ({ kind: 'missing' })
    )
    const read = createSessionSummaryEventReader({ fetchSshTranscript })

    const events = await read({
      identity: { agentType: 'pi', providerSession: { key: 'session_id', id: 'sess-1' } },
      host: sshHost,
      signal: new AbortController().signal
    })

    expect(events).toBeNull()
    expect(fetchSshTranscript).not.toHaveBeenCalled()
  })

  it('refuses an agent whose transcript cannot be decoded by content alone', async () => {
    const fetchSshTranscript = vi.fn(
      async (_args: {
        targetId: string
        remotePath: string
        signal: AbortSignal
      }): Promise<RemoteTranscriptFetch> => ({ kind: 'missing' })
    )
    const read = createSessionSummaryEventReader({ fetchSshTranscript })

    // Copilot names no path, and its session directory cannot be synthesized for a
    // remote home directory, so there is nothing to fetch.
    const events = await read({
      identity: {
        agentType: 'copilot',
        providerSession: { key: 'session_id', id: 'abc123', transcriptPath: '/r/events.jsonl' }
      },
      host: sshHost,
      signal: new AbortController().signal
    })

    expect(events).toBeNull()
    expect(fetchSshTranscript).not.toHaveBeenCalled()
  })

  it('reports an oversized transcript as a failure, never as a short one', async () => {
    const read = createSessionSummaryEventReader({
      fetchSshTranscript: async () => ({ kind: 'too-large', bytes: 60 * 1024 * 1024 })
    })

    await expect(
      read({
        identity: {
          agentType: 'pi',
          providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/r/x.jsonl' }
        },
        host: sshHost,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/over 24 MB.*too large/)
  })

  it('reports a deleted remote transcript as absent', async () => {
    const read = createSessionSummaryEventReader({
      fetchSshTranscript: async () => ({ kind: 'missing' })
    })

    const events = await read({
      identity: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/r/x.jsonl' }
      },
      host: sshHost,
      signal: new AbortController().signal
    })

    expect(events).toBeNull()
  })
})
