import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummaryQuestion } from '../../shared/session-summary-types'
import { SessionSummaryQuestionStore } from './session-summary-question-store'

const IDENTITY = { providerSessionId: 'p1', transcriptPath: '/tmp/p1.jsonl' }

// Questions are the reader's own words and a paid answer, so unlike the ledger cache they must
// survive a reopen, a bad row and a quit mid-answer, and stay bounded (#280).
describe('SessionSummaryQuestionStore', () => {
  let directory: string
  const filePath = (): string => join(directory, 'session-summary-questions.json')

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-summary-questions-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('round-trips questions, and a pending one reads back as interrupted and retryable', async () => {
    const store = new SessionSummaryQuestionStore(filePath())
    await store.ready
    store.set('pane', {
      identity: IDENTITY,
      updatedAt: 10,
      questions: [
        { id: 'q1', text: 'Why?', askedAt: 1, status: 'answered', answer: 'Because.', through: 4 },
        { id: 'q2', text: 'And then?', askedAt: 2, status: 'pending', through: 4 }
      ]
    })
    await store.flush()

    const reopened = new SessionSummaryQuestionStore(filePath())
    await reopened.ready

    expect(reopened.get('pane')).toEqual({
      identity: IDENTITY,
      updatedAt: 10,
      questions: [
        { id: 'q1', text: 'Why?', askedAt: 1, status: 'answered', answer: 'Because.', through: 4 },
        {
          id: 'q2',
          text: 'And then?',
          askedAt: 2,
          status: 'failed',
          through: 4,
          error: 'ask-interrupted'
        }
      ]
    })
  })

  it('keeps a question asked before the file was read beside the ones already in it', async () => {
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        entries: {
          pane: {
            identity: IDENTITY,
            updatedAt: 1,
            questions: [{ id: 'old', text: 'Old?', askedAt: 1, status: 'answered', answer: 'Yes.' }]
          }
        }
      })
    )
    const store = new SessionSummaryQuestionStore(filePath())
    store.set('pane', {
      identity: IDENTITY,
      updatedAt: 2,
      questions: [{ id: 'new', text: 'New?', askedAt: 2, status: 'pending' }]
    })
    await store.flush()

    const ids = new SessionSummaryQuestionStore(filePath())
    await ids.ready
    expect(ids.get('pane')?.questions.map((question) => question.id)).toEqual(['old', 'new'])
  })

  it('never writes a file for a process that recorded nothing', async () => {
    const store = new SessionSummaryQuestionStore(filePath())
    await store.flush()

    expect(existsSync(filePath())).toBe(false)
  })

  it('keeps at most fifty questions a pane, evicting settled ones before a pending answer', async () => {
    const store = new SessionSummaryQuestionStore(filePath())
    await store.ready
    const questions: SessionSummaryQuestion[] = [
      { id: 'paid', text: 'In flight', askedAt: 0, status: 'pending' },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `q${index}`,
        text: `question ${index}`,
        askedAt: index + 1,
        status: 'failed' as const,
        error: 'x'
      }))
    ]
    store.set('pane', { identity: IDENTITY, updatedAt: 1, questions })

    const kept = store.get('pane')?.questions ?? []
    expect(kept).toHaveLength(50)
    expect(kept[0]?.id).toBe('paid')
    expect(kept[1]?.id).toBe('q11')
    expect(kept.at(-1)?.id).toBe('q59')
  })

  // Why a multibyte answer too: the ceiling is on disk bytes, and CJK text is three per character.
  it.each([
    ['ASCII', 'a'],
    ['multibyte', '界']
  ])('evicts the oldest panes once the file would pass its byte ceiling (%s)', async (_, char) => {
    const store = new SessionSummaryQuestionStore(filePath())
    await store.ready
    const answer = char.repeat(4_000)
    for (let pane = 0; pane < 20; pane++) {
      store.set(`pane-${pane}`, {
        identity: IDENTITY,
        updatedAt: pane,
        questions: Array.from({ length: 50 }, (_, index) => ({
          id: `q${index}`,
          text: 'Why?',
          askedAt: index,
          status: 'answered' as const,
          answer
        }))
      })
    }
    await store.flush()

    expect(readFileSync(filePath()).byteLength).toBeLessThanOrEqual(2_000_000)
    expect(store.get('pane-0')).toBeNull()
    expect(store.get('pane-19')).not.toBeNull()
  })

  it('drops a malformed row without losing the rest of the file', async () => {
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        entries: {
          good: {
            identity: IDENTITY,
            updatedAt: 5,
            questions: [
              { id: 'ok', text: 'Kept?', askedAt: 3, status: 'answered', answer: 'Yes.' },
              { id: 'no-text', text: '', askedAt: 3, status: 'answered', answer: 'x' },
              { id: 'bad-status', text: 'x', askedAt: 3, status: 'thinking' },
              'not a question'
            ]
          },
          noIdentity: { updatedAt: 5, questions: [{ id: 'q', text: 'x', askedAt: 1 }] },
          notAnEntry: 42
        }
      })
    )

    const store = new SessionSummaryQuestionStore(filePath())
    await store.ready

    expect(store.get('good')?.questions).toEqual([
      { id: 'ok', text: 'Kept?', askedAt: 3, status: 'answered', answer: 'Yes.' }
    ])
    expect(store.get('noIdentity')).toBeNull()
    expect(store.get('notAnEntry')).toBeNull()
  })

  it('starts empty on a corrupt file instead of failing', async () => {
    writeFileSync(filePath(), '{ not json')

    const store = new SessionSummaryQuestionStore(filePath())
    await store.ready

    expect(store.get('pane')).toBeNull()
  })
})
