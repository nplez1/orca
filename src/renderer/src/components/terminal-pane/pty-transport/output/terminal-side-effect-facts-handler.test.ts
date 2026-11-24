import { describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectBatch } from '../../../../../../shared/terminal/output/terminal-side-effect-facts'
import {
  dispatchTerminalSideEffectBatch,
  registerTerminalSideEffectFactConsumer,
  type TerminalSideEffectFactConsumerCallbacks
} from './terminal-side-effect-facts-handler'

const PTY_ID = 'wt-1#1'

function createCallbackRecorder(): {
  callbacks: TerminalSideEffectFactConsumerCallbacks
  events: unknown[][]
} {
  const events: unknown[][] = []
  return {
    events,
    callbacks: {
      onTitleChange: (normalizedTitle, rawTitle) =>
        events.push(['title', normalizedTitle, rawTitle]),
      onBell: () => events.push(['bell']),
      onAgentBecameIdle: (title) => events.push(['idle', title]),
      onAgentBecameWorking: () => events.push(['working']),
      onAgentExited: () => events.push(['exited'])
    }
  }
}

function batch(
  facts: TerminalSideEffectBatch['facts'],
  options: Partial<TerminalSideEffectBatch> = {}
): TerminalSideEffectBatch {
  return { ptyId: PTY_ID, seq: 0, facts, ...options }
}

describe('foreground-changed facts', () => {
  it('routes runtime input to the input path and a host notice to the foreground path', () => {
    // CLI input must reach the pane as input, so a command pane paces it on its slow re-check (#46045).
    const onRuntimeInput = vi.fn()
    const onForegroundChanged = vi.fn()
    const unregister = registerTerminalSideEffectFactConsumer({
      ptyId: 'pty-1',
      callbacks: { onRuntimeInput, onForegroundChanged }
    })

    dispatchTerminalSideEffectBatch({
      ptyId: 'pty-1',
      seq: 1,
      facts: [{ kind: 'foreground-changed', input: true }]
    })
    expect(onRuntimeInput).toHaveBeenCalledTimes(1)
    expect(onForegroundChanged).not.toHaveBeenCalled()

    dispatchTerminalSideEffectBatch({
      ptyId: 'pty-1',
      seq: 2,
      facts: [{ kind: 'foreground-changed' }]
    })
    expect(onForegroundChanged).toHaveBeenCalledTimes(1)
    expect(onRuntimeInput).toHaveBeenCalledTimes(1)
    unregister()
  })
})

describe('restoredUnconfirmed title facts', () => {
  // Why: the stamped titles are exactly what getTerminalSideEffectSnapshot serves after a
  // cold restore of checkpoint.json's spinner-form lastTitle. Readers must not read working
  // from restored history, while observed titles (park/unpark and worktree-switch replays)
  // stay trusted.
  it('keeps a restored spinner title from reading as working', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    dispatchTerminalSideEffectBatch(
      batch(
        [
          {
            kind: 'title',
            normalizedTitle: '⠋ π - Jenkins-Details',
            rawTitle: '⠋ π - Jenkins-Details',
            restoredUnconfirmed: true
          }
        ],
        { replay: true }
      )
    )

    expect(events).toEqual([['title', 'π - Jenkins-Details', 'π - Jenkins-Details']])
  })

  it('treats an unconfirmed working claim in a live fact the same way', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    dispatchTerminalSideEffectBatch(
      batch([
        {
          kind: 'title',
          normalizedTitle: '⠋ π - Remove-Team',
          rawTitle: '⠧ π - Remove-Team',
          restoredUnconfirmed: true
        }
      ])
    )

    expect(events).toEqual([['title', 'π - Remove-Team', 'π - Remove-Team']])
  })

  it('passes observed replays through verbatim', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    dispatchTerminalSideEffectBatch(
      batch(
        [
          {
            kind: 'title',
            normalizedTitle: '⠋ π - Jenkins-Details',
            rawTitle: '⠋ π - Jenkins-Details'
          }
        ],
        { replay: true }
      )
    )

    expect(events).toEqual([['title', '⠋ π - Jenkins-Details', '⠋ π - Jenkins-Details']])
  })

  it('keeps restored permission markers signalling', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    dispatchTerminalSideEffectBatch(
      batch([
        {
          kind: 'title',
          normalizedTitle: '⠋ π ! Jenkins-Details',
          rawTitle: '⠋ π ! Jenkins-Details',
          restoredUnconfirmed: true
        }
      ])
    )

    expect(events).toEqual([['title', '⠋ π ! Jenkins-Details', '⠋ π ! Jenkins-Details']])
  })

  it('rewrites a restored OMP static working marker to the idle marker', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    dispatchTerminalSideEffectBatch(
      batch([
        {
          kind: 'title',
          normalizedTitle: 'π : my-project',
          rawTitle: 'π : my-project',
          restoredUnconfirmed: true
        }
      ])
    )

    expect(events).toEqual([['title', 'π > my-project', 'π > my-project']])
  })
})
