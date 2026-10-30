import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalFileSink } from './local-file-sink'
import { recordSwallowedFailure } from './swallowed-failure'
import { _resetTracerForTests, setActiveSink, type TracerSink } from './tracer'

function makeCapturingSink(): TracerSink & { records: unknown[] } {
  const records: unknown[] = []
  return {
    records,
    push: (record) => records.push(record),
    flush() {},
    close() {}
  }
}

let sink: ReturnType<typeof makeCapturingSink>

beforeEach(() => {
  sink = makeCapturingSink()
  setActiveSink(sink)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  _resetTracerForTests()
  vi.restoreAllMocks()
})

describe('recordSwallowedFailure', () => {
  it('records the subsystem, the operation and the failure as a tracer span', () => {
    recordSwallowedFailure('jira', new Error('boom'), 'issue project read')

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      type: 'effect-span',
      name: 'swallowed-failure',
      attributes: { subsystem: 'jira', detail: 'issue project read' },
      exit: { _tag: 'Failure', cause: expect.stringContaining('boom') }
    })
  })

  it('omits the detail attribute when the call site names no operation', () => {
    recordSwallowedFailure('session-summary', new Error('disk full'))

    expect(sink.records[0]).toMatchObject({ attributes: { subsystem: 'session-summary' } })
    expect(sink.records[0]).not.toMatchObject({
      attributes: { detail: expect.anything() }
    })
  })

  it('records a non-Error value rather than dropping it', () => {
    recordSwallowedFailure('ephemeral-vm', 'store is not json')

    expect(sink.records[0]).toMatchObject({
      exit: { _tag: 'Failure', cause: expect.stringContaining('store is not json') }
    })
  })

  it('keeps the console line, which is all a diagnostics-disabled build has', () => {
    recordSwallowedFailure('worktree-symlinks', new Error('EPERM'), 'materialize')

    expect(console.warn).toHaveBeenCalledWith('[worktree-symlinks] materialize:', expect.any(Error))
  })

  it('keeps the console severity a call site already relied on', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    recordSwallowedFailure('worktree-symlinks', new Error('EPERM'), 'materialize', 'error')

    expect(errorSpy).toHaveBeenCalledWith('[worktree-symlinks] materialize:', expect.any(Error))
    expect(console.warn).not.toHaveBeenCalled()
    expect(sink.records).toHaveLength(1)
  })

  it('writes the record into the file the diagnostic bundle collects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-swallowed-failure-'))
    const traceFilePath = join(directory, 'main.trace.ndjson')
    try {
      const fileSink = createLocalFileSink({ filePath: traceFilePath })
      setActiveSink(fileSink)
      recordSwallowedFailure('ai-vault-search', new Error('database is locked'), 'schema check')
      fileSink.flush()
      fileSink.close()

      const lines = readFileSync(traceFilePath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({
        type: 'effect-span',
        name: 'swallowed-failure',
        attributes: { subsystem: 'ai-vault-search', detail: 'schema check' },
        exit: { _tag: 'Failure' }
      })
    } finally {
      _resetTracerForTests()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
