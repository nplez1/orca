import { describe, expect, it } from 'vitest'
import {
  agentLaunchDependsOnWorkspaceTrust,
  withAgentTrustLaunchArgs
} from './agent-trust-launch-args'

const PI_DRAFT_CLEANUP_POSIX =
  '; command test -n "$fish_pid" && set --erase -g ORCA_PI_PREFILL; command test -z "$fish_pid" && unset ORCA_PI_PREFILL; true'

describe('withAgentTrustLaunchArgs', () => {
  it('splices the trust flag in after the pi executable', () => {
    expect(withAgentTrustLaunchArgs("pi 'do the thing'", 'pi', 'posix')).toBe(
      "pi --approve 'do the thing'"
    )
    expect(withAgentTrustLaunchArgs("pi --model opus 'p'", 'pi', 'posix')).toBe(
      "pi --approve --model opus 'p'"
    )
    expect(withAgentTrustLaunchArgs('pi', 'pi', 'posix')).toBe('pi --approve')
    expect(withAgentTrustLaunchArgs('/opt/bin/pi', 'pi', 'posix')).toBe('/opt/bin/pi --approve')
  })

  it('keeps the draft cleanup suffix after the flag', () => {
    expect(withAgentTrustLaunchArgs(`pi${PI_DRAFT_CLEANUP_POSIX}`, 'pi', 'posix')).toBe(
      `pi --approve${PI_DRAFT_CLEANUP_POSIX}`
    )
    expect(withAgentTrustLaunchArgs('pi & set "ORCA_PI_PREFILL="', 'pi', 'cmd')).toBe(
      'pi --approve & set "ORCA_PI_PREFILL="'
    )
    expect(
      withAgentTrustLaunchArgs(
        'pi; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue',
        'pi',
        'powershell'
      )
    ).toBe('pi --approve; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue')
  })

  it('treats a Windows launcher name as the same executable', () => {
    expect(withAgentTrustLaunchArgs('pi.cmd "p"', 'pi', 'cmd')).toBe('pi.cmd --approve "p"')
    expect(withAgentTrustLaunchArgs('C:\\tools\\pi.exe "p"', 'pi', 'powershell')).toBe(
      'C:\\tools\\pi.exe --approve "p"'
    )
  })

  it('leaves a launch the user already decided', () => {
    expect(withAgentTrustLaunchArgs("pi --no-approve 'p'", 'pi', 'posix')).toBe(
      "pi --no-approve 'p'"
    )
    expect(withAgentTrustLaunchArgs("pi -na 'p'", 'pi', 'posix')).toBe("pi -na 'p'")
    expect(withAgentTrustLaunchArgs("pi --approve 'p'", 'pi', 'posix')).toBe("pi --approve 'p'")
  })

  it('leaves a wrapper, an env prefix or another agent alone', () => {
    expect(withAgentTrustLaunchArgs("npx pi 'p'", 'pi', 'posix')).toBe("npx pi 'p'")
    expect(withAgentTrustLaunchArgs("env -u FOO pi 'p'", 'pi', 'posix')).toBe("env -u FOO pi 'p'")
    expect(withAgentTrustLaunchArgs("claude 'p'", 'claude', 'posix')).toBe("claude 'p'")
  })

  it('edits only the head, so shell syntax inside the prompt is still safe', () => {
    expect(withAgentTrustLaunchArgs("pi 'build > out && run'", 'pi', 'posix')).toBe(
      "pi --approve 'build > out && run'"
    )
  })

  it('refuses a compound command that is not a lone pi invocation', () => {
    expect(withAgentTrustLaunchArgs('cd /tmp && pi', 'pi', 'posix')).toBe('cd /tmp && pi')
    expect(withAgentTrustLaunchArgs('pi; rm -rf /', 'pi', 'posix')).toBe('pi; rm -rf /')
  })
})

describe('agentLaunchDependsOnWorkspaceTrust', () => {
  it('covers an agent whose launch reads the answer as well as one whose trust Orca writes', () => {
    expect(agentLaunchDependsOnWorkspaceTrust('pi')).toBe(true)
    expect(agentLaunchDependsOnWorkspaceTrust('claude')).toBe(true)
    expect(agentLaunchDependsOnWorkspaceTrust('aider')).toBe(false)
    expect(agentLaunchDependsOnWorkspaceTrust(undefined)).toBe(false)
  })
})
