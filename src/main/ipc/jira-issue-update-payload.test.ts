import { describe, expect, it } from 'vitest'
import { normalizeIssueUpdate } from './jira-issue-update-payload'

/** Every field the boundary accepts, in one payload. The RPC contract's suite
 *  (src/shared/rpc-contract/jira-params.test.ts) carries the same fixture, because
 *  both boundaries must keep accepting it. */
const FULL_UPDATE = {
  title: 'Fix the thing',
  labels: ['bug', 'jira'],
  assigneeAccountId: 'acc-1',
  priorityId: '3',
  transitionId: '5',
  transitionFields: { customfield_1: 'x' },
  transitionComment: 'Done',
  transitionUserFieldKeys: ['customfield_1'],
  transitionTextFieldKeys: ['customfield_2'],
  customFields: { customfield_2: 'text', customfield_3: null },
  userFieldKeys: ['customfield_3'],
  textFieldKeys: ['customfield_2'],
  sprintId: '42'
}

const ACCEPTED: [string, unknown][] = [
  ['every accepted field', FULL_UPDATE],
  ['an empty update', {}],
  ['nulls that clear a field', { assigneeAccountId: null, priorityId: null, sprintId: null }],
  // Not a whitelist: the narrower checks the fields it knows and hands the rest on,
  // so an undeclared key survives here and is inert downstream, where only named
  // keys are read (see updateIssue in jira-issue-mutations.ts).
  ['an unknown top-level key', { title: 'T', fieldValues: { summary: 'x' } }],
  // An array has no named update keys to apply, so it narrows to an update that does
  // nothing. Kept as a case because it is the same branch as the object check.
  ['a top-level array', []]
]

const REJECTED: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'title'],
  ['a number', 7],
  ['a non-string title', { title: 5 }],
  ['labels that are not an array', { labels: 'bug' }],
  ['labels with a non-string entry', { labels: ['bug', 5] }],
  ['a non-string assignee', { assigneeAccountId: 5 }],
  ['a non-string priority', { priorityId: 5 }],
  ['a non-string transition id', { transitionId: 5 }],
  // A blank id is malformed rather than a clear: reading "" as the backlog would
  // silently move the issue out of its sprint.
  ['a blank sprint id', { sprintId: '' }],
  ['a whitespace sprint id', { sprintId: '  ' }],
  ['a numeric sprint id', { sprintId: 42 }],
  ['a system field in the custom-field map', { customFields: { reporter: 'acc-1' } }],
  ['a custom-field map that is an array', { customFields: [] }],
  ['a custom-field map that is a string', { customFields: 'customfield_1' }],
  ['transition fields that are an array', { transitionFields: [] }],
  ['transition fields that are a string', { transitionFields: 'customfield_1' }],
  ['user field keys with a non-string entry', { userFieldKeys: ['customfield_1', 2] }],
  ['user field keys that are a string', { userFieldKeys: 'customfield_1' }],
  [
    'transition user field keys with a non-string entry',
    { transitionUserFieldKeys: ['customfield_1', 2] }
  ],
  ['text field keys with a non-string entry', { textFieldKeys: ['customfield_2', 2] }],
  [
    'transition text field keys with a non-string entry',
    { transitionTextFieldKeys: ['customfield_2', 2] }
  ]
]

describe('normalizeIssueUpdate', () => {
  it.each(ACCEPTED)('accepts %s', (_label, payload) => {
    expect(normalizeIssueUpdate(payload)).toEqual(payload)
  })

  it.each(REJECTED)('rejects %s', (_label, payload) => {
    expect(normalizeIssueUpdate(payload)).toBeNull()
  })
})
