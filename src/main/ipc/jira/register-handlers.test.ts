import { beforeEach, describe, expect, it, vi } from 'vitest'

type RegisteredHandler = (event: unknown, args: unknown) => Promise<unknown>

const { updateIssue, handle } = vi.hoisted(() => ({
  updateIssue: vi.fn(async () => ({ ok: true })),
  handle: vi.fn<(channel: string, listener: RegisteredHandler) => void>()
}))

vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('../../jira/jira-issue-mutations', () => ({
  updateIssue,
  createIssue: vi.fn(),
  addIssueComment: vi.fn()
}))

import { registerJiraHandlers } from './register-handlers'

// Only the fork's narrower rejects these; upstream's rebuild does not look at
// customFields and drops sprintId, so without it they reach Jira unchecked.
const FORK_ONLY_REJECTIONS: [string, unknown][] = [
  ['a system field in the custom-field map', { customFields: { reporter: 'acc-1' } }],
  ['a blank sprint id', { sprintId: '' }],
  ['a whitespace sprint id', { sprintId: '  ' }]
]

function updateIssueHandler(): RegisteredHandler {
  const call = handle.mock.calls.find(([channel]) => channel === 'jira:updateIssue')
  if (!call) {
    throw new Error('jira:updateIssue was not registered')
  }
  return call[1]
}

describe('jira:updateIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerJiraHandlers()
  })

  // Why: the handler merges two narrowers — upstream's rebuild, which keeps only the
  // fields it names, and the fork's, which passes the payload through after checking
  // it. The upstream rebuild spreads last, so it wins for a key both carry; an
  // undeclared label operation is the one case where the two disagree about the
  // value, and reversing the spread would send it to Jira.
  it('prefers the upstream rebuild for a key both narrowers carry', async () => {
    await updateIssueHandler()(null, {
      key: 'A-1',
      updates: { labelOperations: { add: ['bug'], remove: ['stale'], replace: ['x'] } }
    })

    expect(updateIssue).toHaveBeenCalledWith(
      'A-1',
      { labelOperations: { add: ['bug'], remove: ['stale'] } },
      undefined
    )
  })

  // The upstream rebuild drops these, so the fork's object has to reach the merge or
  // every custom-field edit and sprint assignment becomes a silent no-op.
  it('keeps the fork-only fields the upstream rebuild drops', async () => {
    const updates = {
      customFields: { customfield_2: 'text' },
      userFieldKeys: ['customfield_3'],
      textFieldKeys: ['customfield_2'],
      sprintId: '42'
    }

    await updateIssueHandler()(null, { key: 'A-1', updates })

    expect(updateIssue).toHaveBeenCalledWith('A-1', updates, undefined)
  })

  it.each(FORK_ONLY_REJECTIONS)(
    'refuses %s before it reaches the client',
    async (_label, updates) => {
      const result = await updateIssueHandler()(null, { key: 'A-1', updates })

      expect(result).toEqual({
        ok: false,
        errorCode: 'jira.updatesRequired',
        error: 'Updates object is required.'
      })
      expect(updateIssue).not.toHaveBeenCalled()
    }
  )
})
