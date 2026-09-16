export function getOrcaCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'orca-np'
  }
  if (platform === 'win32') {
    return 'orca-np.cmd'
  }
  return 'orca-np'
}

/**
 * The command name the SSH relay deploys on a remote execution host.
 *
 * Why separate from `getOrcaCliCommandNameForPlatform`: the relay ships its own shim under a fixed
 * name, so a remote launch must NOT follow the locally installed rename. Conflating the two makes a
 * remote launch invoke a command the remote PATH never had.
 */
export function getRelayCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'orca.cmd' : 'orca'
}
