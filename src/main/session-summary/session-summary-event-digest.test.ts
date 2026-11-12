import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'
import { createSessionSummaryEventDigester } from './session-summary-event-digest'

function call(text: string): TranscriptMessage {
  return { role: 'tool', text, timestamp: null, toolKind: 'call' }
}

function result(text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { role: 'tool', text, timestamp: null, toolKind: 'result', ...extra }
}

function user(text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { role: 'user', text, timestamp: null, ...extra }
}

function body(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `  line ${index} of the file`).join('\n')
}

/** A real plugin MCP name: 46 characters, which the old 40-character gate rejected. */
const MCP_TOOL = 'mcp__plugin_github_github__create_pull_request'

describe('createSessionSummaryEventDigester', () => {
  it('keeps user and assistant text in full', () => {
    const digester = createSessionSummaryEventDigester()
    const long = `${'w'.repeat(20_000)}-the-end`
    expect(digester.digest(user(long)).text).toBe(long)
    expect(digester.digest({ role: 'assistant', text: 'thinking', timestamp: null }).text).toBe(
      'thinking'
    )
  })

  // The reader's 256 KB per-message guard is a real bound, so the digest names it rather than
  // implying it read everything.
  it('names the bound that replaced a message’s text', () => {
    const digester = createSessionSummaryEventDigester()
    const event = digester.digest(
      user('kept text', { textTruncated: true, textOriginalLength: 400_000 })
    )
    expect(event.text).toContain('kept text')
    expect(event.text).toContain('[truncated at 390.6 KB read]')
    expect(event.textTruncated).toBe(true)
    expect(event.textOriginalLength).toBe(400_000)
  })

  // Acceptance 9: a 900-line file read yields one line naming the path and the line count, with no
  // body.
  it('digests a 900-line read to a single line naming the path and the size', () => {
    const digester = createSessionSummaryEventDigester()
    const callEvent = digester.digest(call('Read: /repo/src/foo.ts'))
    const resultEvent = digester.digest(result(body(900)))

    expect(callEvent.text).toBe('Read /repo/src/foo.ts')
    expect(resultEvent.text).toContain('Read /repo/src/foo.ts')
    expect(resultEvent.text).toContain('900 lines')
    expect(resultEvent.text).toContain('ok')
    // No line of the file's body survives.
    expect(resultEvent.text).not.toContain('line 0 of the file')
    expect(resultEvent.text).not.toContain('line 899 of the file')
    expect(resultEvent.text.split('\n')).toHaveLength(1)
  })

  // Acceptance 9: a failing command yields its exit code and the first error line.
  it('digests a failing command to its exit code and first error line', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Bash: npm test'))
    const event = digester.digest(
      result(
        [
          '> orca@1.0.0 test',
          '> vitest run',
          '',
          'FAIL src/x.test.ts > adds a flag',
          'AssertionError: expected 1 to be 2',
          'Tests 1 failed | 411 passed',
          'Process exited with code 1'
        ].join('\n')
      )
    )
    expect(event.text).toContain('Bash npm test')
    expect(event.text).toContain('7 lines')
    expect(event.text).toContain('exit 1')
    expect(event.text).toContain('FAIL src/x.test.ts > adds a flag')
    expect(event.text).not.toContain('AssertionError')
  })

  it('reports a clean command as ok without inventing a failure', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Bash: npm run build'))
    const event = digester.digest(result('built 42 modules\nExit code: 0'))
    expect(event.text).toContain('exit 0')
    expect(event.text).not.toContain('failed')
  })

  // A shell script's own `exit 1` is not a command's exit status: the pattern is anchored to the
  // forms a harness emits, or every read of a script would be reported as a failed command.
  it('does not call a read failed because the file contains an exit statement', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Read: /repo/deploy.sh'))
    const event = digester.digest(
      result(['#!/bin/sh', 'if [ -z "$1" ]; then', '  exit 1', 'fi'].join('\n'))
    )
    expect(event.text).toContain('ok')
    expect(event.text).not.toContain('exit 1')
  })

  // A file whose contents mention errors is not a failure: the trigger has to be structural, or
  // every read of a source file would be reported as broken.
  it('does not call a file read failed because its contents mention errors', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Read: /repo/src/errors.ts'))
    const event = digester.digest(
      result(['export type E = { error: string }', "const x = 'error: bad input'"].join('\n'))
    )
    expect(event.text).toContain('ok')
    expect(event.text).not.toContain('failed')
  })

  // Agents issue parallel calls, so results arrive in call order after both calls.
  it('pairs results with calls in order', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Read: /a.ts'))
    digester.digest(call('Grep: TODO'))
    expect(digester.digest(result('a body\nsecond line')).text).toContain('Read /a.ts')
    expect(digester.digest(result('12 matches')).text).toContain('Grep TODO')
  })

  it('falls back to a plain label when no call is pending', () => {
    const digester = createSessionSummaryEventDigester()
    expect(digester.digest(result('orphan output')).text).toContain('tool result')
  })

  // #386: an MCP name runs past 40 characters, and a name the gate rejected left the pending call
  // anonymous, so its failure read `tool result` and nothing named the tool that failed.
  it('names a long MCP tool on its own result', () => {
    const digester = createSessionSummaryEventDigester()
    const callEvent = digester.digest(call(`${MCP_TOOL}: owner/repo`))
    const resultEvent = digester.digest(
      result(['Error: Validation Failed', 'Command failed'].join('\n'))
    )

    expect(callEvent.tool?.name).toBe(MCP_TOOL)
    expect(resultEvent.tool?.name).toBe(MCP_TOOL)
    expect(resultEvent.tool?.label).toBe(`${MCP_TOOL} owner/repo`)
    expect(resultEvent.text).toBe(
      `${MCP_TOOL} owner/repo · 2 lines / 39 B · failed · Error: Validation Failed`
    )
  })

  // The name gate exists to reject a sentence that happens to contain a colon, and the fallback has
  // to be the call's own line: labelling it `tool result` is what lost the identity in the first
  // place. A harness that omits the name emits the call's input as its text.
  it('repeats the call’s own line when its name does not parse', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('{"path": "/repo/x.ts"}'))
    const event = digester.digest(result('one line'))
    expect(event.tool?.name).toBeNull()
    expect(event.text).toBe('{"path": "/repo/x.ts"} · 1 line / 8 B · ok')
  })

  // A fold resumes at a cursor, so the call sits before it and only its result is digested. The
  // label has to survive the skip, which is why the digest owns it rather than the render merge.
  it('names a skipped long-named call on the result after the cursor', () => {
    const digester = createSessionSummaryEventDigester()
    digester.skip(call(`${MCP_TOOL}: owner/repo`))
    const event = digester.digest(result(['Error: Validation Failed', 'Command failed'].join('\n')))
    expect(event.text).toBe(
      `${MCP_TOOL} owner/repo · 2 lines / 39 B · failed · Error: Validation Failed`
    )
  })

  // A fold resumes at a cursor: the messages before it are counted, not retained, but a result
  // after it still belongs to the call before it.
  it('keeps pairing across messages the fold skips', () => {
    const digester = createSessionSummaryEventDigester()
    digester.skip(call('Read: /before-the-cursor.ts'))
    expect(digester.digest(result('body')).text).toContain('Read /before-the-cursor.ts')
  })

  it('bounds the target it names and the error line it quotes', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call(`Bash: ${'x'.repeat(500)}`))
    const event = digester.digest(result(`FAIL ${'y'.repeat(500)}`))
    // Two bounded fields (the target and the quoted error line) plus the accounting.
    expect(event.text.length).toBeLessThan(600)
    expect(event.text).toContain('…')
  })

  // One bounded pass: a failure announced only in the middle of a huge result is not quoted, and
  // the digest of a 256 KB result stays cheap.
  it('scans only the head and the tail of a huge result', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Bash: big'))
    const middle = `${'m'.repeat(20_000)}\nFAIL only-in-the-middle\n${'n'.repeat(20_000)}`
    const event = digester.digest(result(middle))
    expect(event.text).not.toContain('only-in-the-middle')
  })

  it('says when the result itself was cut by the reader', () => {
    const digester = createSessionSummaryEventDigester()
    digester.digest(call('Bash: npm test'))
    const event = digester.digest(
      result('lots of output', { textTruncated: true, textOriginalLength: 900_000 })
    )
    // A tool result's cap stops counting once it is full, so the digest names the limit instead of
    // quoting a figure that is the cap rather than the truth.
    expect(event.text).toContain('truncated by the reader')
  })
})
