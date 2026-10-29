import { describe, expect, it } from 'vitest'
import { JIRA_WRITE_TIMEOUT_MESSAGE } from '../../../shared/jira/jira-write-deadline'
import { JiraWriteTimeoutError, rethrowJiraWriteTimeout } from './jira-write-deadline'

describe('rethrowJiraWriteTimeout', () => {
  it('turns a transport timeout into the verdict the queue re-reads after', () => {
    const transport = new Error('Runtime request timed out before jira.updateIssue completed')

    expect(() => rethrowJiraWriteTimeout(transport)).toThrow(JiraWriteTimeoutError)
  })

  it('keeps its own error and passes an ordinary refusal through untouched', () => {
    expect(() => rethrowJiraWriteTimeout(new JiraWriteTimeoutError())).toThrow(
      JIRA_WRITE_TIMEOUT_MESSAGE
    )

    const refused = new Error('Field refused')
    expect(() => rethrowJiraWriteTimeout(refused)).toThrow(refused)
  })
})
