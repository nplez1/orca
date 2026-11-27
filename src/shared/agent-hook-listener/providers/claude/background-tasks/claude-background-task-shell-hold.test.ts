import { expect, it } from 'vitest'
import { createHookListenerState } from '../../../listener-state'
import { normalizeClaudeEvent } from '../claude-events'

// Why: the fork reads a background shell the agent started as agent work, so such a hold earns no
// `monitoring` badge; a monitor is not a shell and keeps upstream's accounting (local(agents)).
const stopWith = (task: Record<string, unknown>) => {
  const state = createHookListenerState()
  const send = (payload: Record<string, unknown>) =>
    normalizeClaudeEvent(state, payload.hook_event_name, '', 'pane', payload)
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'run it' })
  return send({ hook_event_name: 'Stop', background_tasks: [task] })
}

it('holds a finished turn on a running background shell as plain working, not monitoring', () => {
  const status = stopWith({
    id: 's1',
    type: 'local_bash',
    status: 'running',
    description: 'npm test'
  })
  expect(status).toMatchObject({ state: 'working' })
  expect(status).not.toHaveProperty('workingMode', 'monitoring')
})

it('keeps a monitor at upstream\u2019s monitoring badge, which the shell rule does not reach', () => {
  const status = stopWith({
    id: 'm1',
    type: 'monitor',
    status: 'running',
    description: 'Watch deploy events'
  })
  expect(status).toMatchObject({ state: 'working', workingMode: 'monitoring' })
})
