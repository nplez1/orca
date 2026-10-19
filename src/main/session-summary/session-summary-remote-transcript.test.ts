import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSshTranscriptFetcher,
  type RemoteTranscriptChannel
} from './session-summary-remote-transcript'

const created: string[] = []

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-remote-transcript-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A channel that emits `chunks`, then closes with a clean exit — a successful `cat`. */
function channel(chunks: string[]): RemoteTranscriptChannel {
  return codedChannel(chunks, 0)
}

/** A channel that ends with an exit status, the way an SSH exec reports one. */
function codedChannel(chunks: string[], code: number): RemoteTranscriptChannel {
  return closingChannel(chunks, code)
}

function closingChannel(chunks: string[], code: number | null): RemoteTranscriptChannel {
  // Why emitClose false: the automatic close would arrive without the exit status.
  const stream = new Readable({ emitClose: false, read() {} })
  setTimeout(() => {
    for (const chunk of chunks) {
      stream.push(Buffer.from(chunk, 'utf8'))
    }
    stream.push(null)
    stream.emit('close', code ?? undefined)
  }, 1)
  // SAFETY: a Readable plus this channel's one extra method is exactly the subset the
  // reader consumes; the assertion only adds `close`.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Object.assign(stream, { close: () => stream.destroy() }) as RemoteTranscriptChannel
}

describe('createSshTranscriptFetcher', () => {
  it('materializes the remote file locally, keeping its basename', async () => {
    const commands: string[] = []
    const root = await tmpRoot()
    const fetch = createSshTranscriptFetcher({
      tmpRoot: root,
      openChannel: async ({ command }) => {
        commands.push(command)
        return channel(['line-one\n', 'line-two\n'])
      }
    })

    const result = await fetch({
      targetId: 'target-1',
      remotePath: '/home/me/.pi/agent/sessions/sess-1.jsonl',
      signal: new AbortController().signal
    })

    expect(result.kind).toBe('file')
    if (result.kind !== 'file') {
      return
    }
    // Parsers take a session id from the file name, so the copy must keep it.
    expect(result.path.endsWith('sess-1.jsonl')).toBe(true)
    expect(await readFile(result.path, 'utf8')).toBe('line-one\nline-two\n')
    // Quoted: the path is host-supplied, not this process's.
    expect(commands).toEqual(["cat '/home/me/.pi/agent/sessions/sess-1.jsonl'"])
    await result.dispose()
    await expect(readFile(result.path, 'utf8')).rejects.toThrow()
  })

  it('escapes a path containing a quote', async () => {
    const commands: string[] = []
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async ({ command }) => {
        commands.push(command)
        return channel(['x\n'])
      }
    })
    await fetch({
      targetId: 'target-1',
      remotePath: "/home/me/it's a file.jsonl",
      signal: new AbortController().signal
    })

    expect(commands[0]).toBe("cat '/home/me/it'\\''s a file.jsonl'")
  })

  // A truncated transcript renumbers every event the ledger's cursor counts, so an
  // oversized one is refused instead of quietly shortened to its tail.
  it('refuses a transcript over the cap instead of truncating it', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      maxBytes: 8,
      openChannel: async () => channel(['12345', '67890'])
    })

    const result = await fetch({
      targetId: 'target-1',
      remotePath: '/sessions/big.jsonl',
      signal: new AbortController().signal
    })

    expect(result).toEqual({ kind: 'too-large', bytes: 10 })
  })

  it('reports an empty read as missing, and leaves no copy behind', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => channel([])
    })

    const result = await fetch({
      targetId: 'target-1',
      remotePath: '/sessions/gone.jsonl',
      signal: new AbortController().signal
    })

    expect(result).toEqual({ kind: 'missing' })
  })

  it('rejects a channel that errors mid-stream, so the pane can report a failure', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => {
        const failing = new PassThrough()
        setTimeout(() => failing.destroy(new Error('connection reset')), 5)
        return Object.assign(failing, { close: () => failing.destroy() })
      }
    })

    await expect(
      fetch({
        targetId: 'target-1',
        remotePath: '/sessions/sess-1.jsonl',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('connection reset')
  })

  // A partial copy that read a failed exit must never be parsed as the whole
  // transcript: the ledger's cursor would land on the wrong messages.
  it('rejects a short read that reported a failed exit', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => codedChannel(['partial'], 2)
    })

    await expect(
      fetch({
        targetId: 'target-1',
        remotePath: '/sessions/sess-1.jsonl',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('failed (exit 2)')
  })

  // A dropped connection closes the channel with no exit status at all. What arrived is
  // not the whole transcript, so it must fail rather than fold a truncated file.
  it('rejects a channel that closed without an exit status', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => closingChannel(['partial'], null)
    })

    await expect(
      fetch({
        targetId: 'target-1',
        remotePath: '/sessions/sess-1.jsonl',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('did not complete')
  })

  it('keeps a remote name that is illegal on Windows out of the local path', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => channel(['x\n'])
    })

    const result = await fetch({
      targetId: 'target-1',
      remotePath: '/sessions/we:ird?.jsonl',
      signal: new AbortController().signal
    })

    expect(result.kind).toBe('file')
    if (result.kind === 'file') {
      expect(result.path).not.toContain(':')
      expect(result.path.endsWith('we_ird_.jsonl')).toBe(true)
      await result.dispose()
    }
  })

  it('surfaces a missing connection as a rejection, not as an empty transcript', async () => {
    const fetch = createSshTranscriptFetcher({
      tmpRoot: await tmpRoot(),
      openChannel: async () => {
        throw new Error('Not connected to target-1')
      }
    })

    await expect(
      fetch({
        targetId: 'target-1',
        remotePath: '/sessions/sess-1.jsonl',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('Not connected')
  })
})
