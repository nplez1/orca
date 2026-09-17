/**
 * The product name this build shows to users.
 *
 * Why one module: the same name labels the tray, window titles, notifications, the renderer title
 * bar, and the packaged bundle, and those readers live in different bundles — the renderer and the
 * CommonJS build config cannot import a literal that only one of them owns. A name repeated per
 * surface is a rename waiting to half-happen.
 *
 * Why the suffix: this fork is meant to run beside an official Orca and can pair with one, so which
 * build is running has to be tellable at a glance. Display only — the appId, the `orca://` scheme,
 * the CLI name, and every on-disk path keep upstream's identity so pairing links, updates, and
 * existing installs keep working across the upgrade.
 */

/** Packaged builds, and the base of every dev label. */
export const APP_DISPLAY_NAME = 'Orca NP'

/**
 * Dev/E2E name. Constant across branches on purpose: it drives app.setName, and therefore the
 * macOS safeStorage Keychain item, so varying it per branch would mint a new key per worktree.
 */
export const APP_DEV_DISPLAY_NAME = 'Orca NP Dev'
