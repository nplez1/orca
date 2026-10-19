import type { RuntimeCapability } from '../../shared/protocol-version'
import { DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY } from '../../shared/desktop-browser-bridge-protocol'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../shared/mobile-web-bundle/mobile-web-bundle-capability'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../shared/workspace-unread-raise-capability'
import { loadBundledMobileWebBundle } from './bundled-mobile-web-bundle'
import { isDesktopBrowserBridgeHostEnabled } from './desktop-browser-bridge/desktop-browser-bridge-registry'

/** Capabilities that follow how this host is running, not what its build contains. */
export function hostModeRuntimeCapabilities(): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = []
  if (isDesktopBrowserBridgeHostEnabled()) {
    capabilities.push(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)
  }
  // Switch point: this host raises the workspace unread flag itself. The env lets the e2e play an
  // older host without keeping an old binary.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN && process.env.ORCA_E2E_OLDER_UNREAD_HOST !== '1') {
    capabilities.push(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  }
  // Why not a static capability: dev trees and `orca serve` installs may carry no
  // out/mobile-web, and advertising a bundle this install cannot produce would promise a
  // download that only ever answers mobile_web_bundle_unavailable.
  if (loadBundledMobileWebBundle()) {
    capabilities.push(MOBILE_WEB_BUNDLE_CAPABILITY)
  }
  return capabilities
}
