import { describe, expect, it } from 'vitest'
import {
  buildWindowsAgentHookCurlPostCommand,
  buildWindowsAgentHookPostCommand,
  WINDOWS_HOOK_AGENT_PROCESS_VAR
} from './installer-utils'

/**
 * Why the field exists: nothing sent the agent's process on Windows, so `hasOtherAgentProcessOwner`
 * never fired there and a nested `claude -p` posting a new session looked like the pane's own agent —
 * it cleared the parent's non-teammate roster and its `Stop` folded as the pane's completion (#216 A5).
 *
 * Why an env var rather than a capture here: batch has no `$PPID`, so the JSON has to come from the
 * process that could read it (the native `orca-agent-hook.exe`) and these forms only forward it.
 */
describe('Windows hook agent process forwarding', () => {
  it('forwards the captured identity from the multi-line .cmd form', () => {
    const command = buildWindowsAgentHookPostCommand('claude')

    expect(command).toContain(`--data-urlencode "agentProcess=%${WINDOWS_HOOK_AGENT_PROCESS_VAR}%"`)
    // Extra form lines must stay adjacent to payload@-, which reads stdin last.
    expect(command.indexOf('agentProcess=')).toBeLessThan(command.indexOf('payload@-'))
  })

  it('forwards it from the single-line curl form too', () => {
    expect(buildWindowsAgentHookCurlPostCommand('claude')).toContain(
      `--data-urlencode "agentProcess=%${WINDOWS_HOOK_AGENT_PROCESS_VAR}%"`
    )
  })
})
