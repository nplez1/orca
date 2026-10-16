import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { ownedSourceTarget } from './provider-source-target'

function jiraSource(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return { kind: 'task-source', provider: 'jira', projectId: 'project', hostId }
}

describe('ownedSourceTarget', () => {
  it('routes a task source to the host that owns the row', () => {
    expect(ownedSourceTarget(jiraSource('runtime:owner'))).toEqual({
      kind: 'environment',
      environmentId: 'owner'
    })
  })

  it.each(['local', 'ssh:example'] as const)(
    'serves a %s row from this app, which is the only route it has',
    (hostId) => {
      expect(ownedSourceTarget(jiraSource(hostId))).toEqual({ kind: 'local' })
    }
  )

  it('passes an already-decided target through unchanged', () => {
    expect(ownedSourceTarget({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(ownedSourceTarget({ kind: 'environment', environmentId: 'owner' })).toEqual({
      kind: 'environment',
      environmentId: 'owner'
    })
  })

  it('keeps an unresolved owner a server target, so the call fails instead of running here', () => {
    expect(ownedSourceTarget(jiraSource('runtime:unresolved-owner'))).toEqual({
      kind: 'environment',
      environmentId: 'unresolved-owner'
    })
  })
})
