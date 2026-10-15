import { describe, expect, it } from 'vitest'
import { CreateIssue, IssueUpdate } from './jira-params'

describe('Jira RPC params', () => {
  // Why guarded here: a zod object strips keys it does not name, and the
  // dispatcher hands the stripped object to the handler, so an undeclared field
  // is a silent no-op on every remote runtime.
  it('preserves the new issue-update field maps and key lists', () => {
    const updates = {
      transitionId: '5',
      transitionFields: { customfield_1: 'x' },
      transitionUserFieldKeys: ['customfield_1'],
      transitionTextFieldKeys: ['customfield_2'],
      customFields: { customfield_2: 'text', customfield_3: null },
      userFieldKeys: ['customfield_3'],
      textFieldKeys: ['customfield_2']
    }

    const parsed = IssueUpdate.parse({ key: 'A-1', updates })

    expect(parsed.updates).toEqual(updates)
  })

  it('preserves the create text field keys', () => {
    const parsed = CreateIssue.parse({
      projectId: '1',
      issueTypeId: '2',
      title: 'T',
      customFields: { customfield_2: 'x' },
      textFieldKeys: ['customfield_2']
    })

    expect(parsed.textFieldKeys).toEqual(['customfield_2'])
  })

  it('refuses a system-field key in the field-edit map, as the local path does', () => {
    const result = IssueUpdate.safeParse({
      key: 'A-1',
      updates: { customFields: { reporter: 'acc-1' } }
    })

    expect(result.success).toBe(false)
  })
})
