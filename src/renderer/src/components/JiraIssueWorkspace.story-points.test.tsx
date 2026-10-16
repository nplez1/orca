// @vitest-environment happy-dom

import {
  deferred,
  flushPromises,
  jiraIssue,
  runtimeMocks,
  StoreBackedWorkspace,
  toast
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { JiraEditableField } from '../../../shared/jira-types'

const POINTS_FIELD_KEY = 'customfield_10016'

function pointsField(value: string): JiraEditableField {
  return {
    field: {
      key: POINTS_FIELD_KEY,
      name: 'Story Points',
      required: false,
      schema: {
        type: 'number',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float'
      }
    },
    value
  }
}

async function openPointsEditor(from: string, to: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: `Story points: ${from}` }))
  const input = screen.getByRole('textbox', { name: 'Story points' })
  await user.clear(input)
  await user.type(input, to)
  await user.click(screen.getByRole('button', { name: 'Save' }))
}

describe('JiraIssueWorkspace story points', () => {
  it('writes the points and re-reads the fields the edit form builds itself from', async () => {
    runtimeMocks.jiraUpdateIssueForTarget.mockResolvedValue({ ok: true })
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Story', { storyPoints: 5 }))
      .mockResolvedValue(jiraIssue('Story', { storyPoints: 8 }))
    runtimeMocks.jiraListEditFieldsForTarget.mockResolvedValue([pointsField('5')])
    render(<StoreBackedWorkspace initial={jiraIssue('Story', { storyPoints: 5 })} />)
    await flushPromises()

    await openPointsEditor('5', '8')
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
      expect.anything(),
      'ENG-1',
      { customFields: { [POINTS_FIELD_KEY]: 8 } },
      'site-1'
    )
    // The edit form seeds its drafts from this read, so a value written here has to
    // be re-read or the two forms disagree about what the field holds.
    expect(runtimeMocks.jiraListEditFieldsForTarget.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: 'Story points: 8' })).toBeTruthy()
  })

  it('keeps the points where they were when Jira refuses the write', async () => {
    const write = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(write.promise)
    runtimeMocks.jiraGetIssueForTarget.mockResolvedValue(jiraIssue('Story', { storyPoints: 5 }))
    runtimeMocks.jiraListEditFieldsForTarget.mockResolvedValue([pointsField('5')])
    render(<StoreBackedWorkspace initial={jiraIssue('Story', { storyPoints: 5 })} />)
    await flushPromises()

    await openPointsEditor('5', '8')
    await flushPromises()

    // The card moves with the write, and returns when Jira rejects it.
    expect(screen.getByRole('button', { name: 'Story points: 8' })).toBeTruthy()
    await act(async () => write.resolve({ ok: false, error: 'Not a number' }))
    await flushPromises()

    expect(screen.getByRole('button', { name: 'Story points: 5' })).toBeTruthy()
    // The reason has to reach the user; this form has nowhere to show it.
    expect(toast.error).toHaveBeenCalledWith('Not a number')
  })
})
