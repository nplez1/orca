// The tree kill for a local command: its process group on POSIX, taskkill on Windows.
import { spawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'
import { admitSelfInitiatedTreeKill } from '../../pty/process-retirement/own-chromium-tree-kill-guard'

/** Named so a tree kill admits only the site that asked for it. */
export type HostCommandKillSite = 'automation-precheck-timeout' | 'automation-command-timeout'

export function killLocalCommandProcessTree(
  child: ChildProcess,
  killSite: HostCommandKillSite
): ReturnType<typeof setTimeout> | null {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    // An exited root's pid may be reused before close; only the handle kill is safe then.
    if (
      childProcessHasExited(child) ||
      !admitSelfInitiatedTreeKill({
        pid,
        site: killSite,
        scope: 'win-taskkill-tree'
      })
    ) {
      child.kill()
      return null
    }
    try {
      // Shell commands can leave descendants running after the root exits.
      const killer = spawn(
        windowsSystem32Binary('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        {
          stdio: 'ignore',
          windowsHide: true
        }
      )
      killer.on('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return null
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill()
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* Ignore errors from the final best-effort group kill. */
    }
  }, 2000)
  forceKillTimer.unref?.()
  return forceKillTimer
}
