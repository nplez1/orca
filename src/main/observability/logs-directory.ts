// Single source of truth for the app's logs directory and the files inside it.
// macOS convention is `~/Library/Application Support/Orca/logs/`; Windows and
// Linux resolve the same intent via the host's `userData` dir. Falls back to a
// homedir-derived path when no AppEnvironment is installed (unit tests).

import { APP_DATA_DIRECTORY_NAME } from '../../shared/app-directory-names'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Use the environment port for plain Node hosts. Keep userData/logs on macOS
// because Electron’s logs path would strand existing bundles.
function getUserDataDir(): string {
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('userData')
  }
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DATA_DIRECTORY_NAME)
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? home, APP_DATA_DIRECTORY_NAME)
  }
  return join(home, '.config', APP_DATA_DIRECTORY_NAME)
}

export function getLogsDirectory(): string {
  return join(getUserDataDir(), 'logs')
}

export function getTraceFilePath(): string {
  return join(getLogsDirectory(), 'main.trace.ndjson')
}

export function getOrcadTraceFilePath(): string {
  return join(getLogsDirectory(), 'orcad.trace.ndjson')
}

export function getDaemonLogFilePath(): string {
  return join(getLogsDirectory(), 'daemon.log')
}

/** Opt-in UI-hang log (Settings → Advanced → Debug Options). Written only while
 *  `uiHangDiagnosticsEnabled` is on; the settings pane shows this exact path so the
 *  user can collect it without hunting through the logs folder. */
export function getUiHangLogFilePath(): string {
  return join(getLogsDirectory(), 'ui-hangs.ndjson')
}
