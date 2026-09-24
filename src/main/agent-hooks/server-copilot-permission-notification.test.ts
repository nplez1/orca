import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeCopilotEventName,
  resolveCopilotEventName
} from '../../shared/agent-hook-listener/providers/copilot-tool-fields'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => null) }))

beforeEach(() => {
  _internals.resetCachesForTests()
})

/** Copilot's `notification` hook is fire-and-forget, so a `permission_prompt` that resolves without
 *  the user (auto-approval, copilot-cli#2586) can land after the tool already ran. */
describe('Copilot permission notifications', () => {
  it('resolves the camelCase permissionRequest payload Copilot actually sends', () => {
    // Why: real permissionRequest payloads carry `hookName`, not `hook_event_name`; without it the
    // tool-name fallback reads the event as a PreToolUse.
    expect(
      normalizeCopilotEventName(
        resolveCopilotEventName(undefined, {
          hookName: 'permissionRequest',
          toolName: 'bash',
          toolInput: { command: 'ls' }
        })
      )
    ).toBe('PermissionRequest')
  })

  it('ignores a permission notification after an auto-approved tool', () => {
    // Why: permission notifications are fire-and-forget and may describe auto-approved requests.
    const states = [
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'clean the cache' }),
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' }
      }),
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' }
      }),
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' },
        tool_result: { text_result_for_llm: 'removed' }
      }),
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash to run?'
      })
    ].map(
      (body) =>
        _internals.normalizeHookPayload('copilot', body, 'production')?.payload.state ?? null
    )

    expect(states).toEqual(['working', 'working', 'working', 'working', null])
  })

  it('does not block on permission_prompt while a tool request is still in flight', () => {
    const states = [
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'clean the cache' }),
      buildBody({ hook_event_name: 'PreToolUse', tool_name: 'bash' }),
      buildBody({ hook_event_name: 'PostToolUse', tool_name: 'bash' }),
      buildBody({ hook_event_name: 'PreToolUse', tool_name: 'bash' }),
      buildBody({ hook_event_name: 'PermissionRequest', tool_name: 'bash' }),
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash to run?'
      })
    ].map(
      (body) =>
        _internals.normalizeHookPayload('copilot', body, 'production')?.payload.state ?? null
    )

    expect(states).toEqual(['working', 'working', 'working', 'working', 'working', null])
  })

  it('continues ignoring permission notifications in a later turn', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'PreToolUse', tool_name: 'bash' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'PostToolUse', tool_name: 'bash' }),
      'production'
    )
    expect(
      _internals.normalizeHookPayload(
        'copilot',
        buildBody({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
        'production'
      )
    ).toBeNull()

    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
      'production'
    )

    expect(result).toBeNull()
  })
})
