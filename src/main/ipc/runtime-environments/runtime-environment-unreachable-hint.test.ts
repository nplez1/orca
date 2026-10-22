import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'

const UNREACHABLE = 'Could not connect to the remote Orca runtime at ws://127.0.0.1:42000.'

describe('withRuntimeUnreachableHint', () => {
  it('points a WSL host at its own reconnect, never at Tailscale', () => {
    const message = withRuntimeUnreachableHint(
      { orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 } },
      UNREACHABLE,
      'ws://127.0.0.1:42000'
    )
    expect(message).not.toMatch(/tailscale/i)
    expect(message).toContain('The Orca server in the WSL distro Ubuntu isn’t answering')
  })

  it('keeps the Tailscale hint for a network server', () => {
    expect(withRuntimeUnreachableHint({}, UNREACHABLE, 'ws://203.0.113.4:6768')).toMatch(
      /tailscale/i
    )
  })

  it('points an ephemeral-VM host at releasing the machine, never at Tailscale', () => {
    const message = withRuntimeUnreachableHint(
      { source: 'ephemeral-vm' as const },
      UNREACHABLE,
      'ws://127.0.0.1:42000'
    )
    expect(message).not.toMatch(/tailscale/i)
    expect(message).toContain('Orca created this VM')
    expect(message).toContain('Settings → Ephemeral VMs')
    // Why no delete advice: the same hint rides connect and terminal failures, where the VM may
    // simply still be booting — so it describes the state and stops there.
    expect(message).not.toMatch(/delet/i)
  })

  it('keeps the VM hint off a failure that is not connectivity', () => {
    expect(withRuntimeUnreachableHint({ source: 'ephemeral-vm' }, 'Unauthorized', null)).toBe(
      'Unauthorized'
    )
  })

  it('does not append the VM hint twice', () => {
    const once = withRuntimeUnreachableHint({ source: 'ephemeral-vm' }, UNREACHABLE, null)
    expect(withRuntimeUnreachableHint({ source: 'ephemeral-vm' }, once, null)).toBe(once)
  })

  it('leaves other failures alone', () => {
    const wsl = {
      orcadDeployment: { kind: 'wsl' as const, distro: 'Ubuntu', localPort: 1, remotePort: 2 }
    }
    expect(withRuntimeUnreachableHint(wsl, 'Unauthorized', null)).toBe('Unauthorized')
  })

  it.each([
    ['a paired server', {}],
    [
      'a legacy SSH-managed server',
      { orcadDeployment: { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 } }
    ],
    [
      'an SSH-managed server',
      {
        orcadDeployment: {
          kind: 'ssh' as const,
          sshTargetId: 't',
          sshTargetGeneration: 1,
          localPort: 1,
          remotePort: 2
        }
      }
    ]
  ])('gives %s exactly the Tailscale hint', (_name, environment) => {
    expect(withRuntimeUnreachableHint(environment, UNREACHABLE, 'ws://203.0.113.4:6768')).toBe(
      withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://203.0.113.4:6768')
    )
  })

  it('pins the full WSL hint text', () => {
    expect(
      withRuntimeUnreachableHint(
        { orcadDeployment: { kind: 'wsl', distro: 'Debian', localPort: 1, remotePort: 2 } },
        'Timed out waiting for the remote Orca runtime.',
        null
      )
    ).toBe(
      'Timed out waiting for the remote Orca runtime. The Orca server in the WSL distro Debian isn’t answering; connect it again in Settings → Remote Orca Servers → WSL hosts.'
    )
  })
})
