// Why this module exists: macOS anchors the helper's Accessibility and Screen Recording grants to
// this bundle id, so it has to name the same app the rest of the install does. The build script is
// CJS and cannot import ORCA_APP_ID, so the value lives here and a test pins it to that constant —
// the rename that introduced the fork namespace missed the helper and left users' grants behind
// under the previous app id, where nothing could reset them.

/** Must stay `${ORCA_APP_ID}.computer-use` — see computer-use-bundle-identity.test.mjs. */
export const COMPUTER_USE_BUNDLE_ID = 'com.nplez1.orca.computer-use'
export const COMPUTER_USE_DISPLAY_NAME = 'Orca Computer Use'
