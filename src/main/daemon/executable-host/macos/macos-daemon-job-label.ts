import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import {
  LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX,
  MAC_DAEMON_JOB_LABEL_PREFIX,
  macDaemonJobLabelWith
} from '../../../fork/install-layout-names'

/** Keep labels stable across upgrades, isolated by profile and protocol. */
export function macDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  return macDaemonJobLabelWith(MAC_DAEMON_JOB_LABEL_PREFIX, userDataPath, protocolVersion)
}

/** The label builds before the appId rename registered; retired once per profile at launch. */
export function legacyMacDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  return macDaemonJobLabelWith(LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX, userDataPath, protocolVersion)
}
