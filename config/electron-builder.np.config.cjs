// Fork-only (LOCAL-PATCHES.md § local(identity)): the release config, renamed to Orca NP so it
// installs beside an official Orca. Why an overlay: electron-builder.config.cjs is upstream's and
// changes most days, so the identity lives here and that file keeps upstream's bytes.
const release = require('./electron-builder.config.cjs')

const productName = 'Orca NP'
const cliCommandName = 'orca-np'
// The package `name`, which NSIS uses for the install directory and electron-builder for the updater
// cache. It stays `orca` in the release config, so an official install and this one would target the
// same `%LOCALAPPDATA%\Programs\orca` and the same `orca-updater` download directory.
const packageName = cliCommandName

// Keyed by upstream's destination. Why the .exe keeps its source: the launcher is built under
// upstream's file name and only the packaged copy is renamed.
const windowsCliResources = {
  'bin/orca.cmd': {
    from: `resources/win32/bin/${cliCommandName}.cmd`,
    to: `bin/${cliCommandName}.cmd`
  },
  'bin/orca.exe': {
    from: 'native/windows-cli-launcher/.build/orca.exe',
    to: `bin/${cliCommandName}.exe`
  }
}

function renameWindowsCli(extraResources) {
  const isCliEntry = (entry) =>
    typeof entry === 'object' && entry !== null && Object.hasOwn(windowsCliResources, entry.to)
  // Why throw: if upstream moves an entry, skipping it would ship an `orca` CLI that collides with
  // an official install's instead of failing the build.
  const missing = Object.keys(windowsCliResources).filter(
    (to) => !extraResources.some((entry) => isCliEntry(entry) && entry.to === to)
  )
  if (missing.length > 0) {
    throw new Error(`win.extraResources no longer ships ${missing.join(', ')}; rename it here`)
  }
  return extraResources.map((entry) => (isCliEntry(entry) ? windowsCliResources[entry.to] : entry))
}

// Why no publisherName: this fork ships unsigned, and electron-updater Authenticode-verifies each
// installer against the installed app-update.yml's name, rejecting its own channel's next build.
// Upstream's dev channels drop it for the same reason.
const { publisherName: _signPathPublisher, ...signtoolOptions } = release.win.signtoolOptions

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...release,
  appId: 'com.nplez1.orca',
  productName,
  // Why spread: a dev-channel build carries its `version` here, and replacing the object would
  // silently stage an unpublished version.
  extraMetadata: { ...release.extraMetadata, name: packageName },
  // Why the scheme stays `orca`: official clients and share links open `orca://`.
  protocols: release.protocols.map((protocol) => ({ ...protocol, name: productName })),
  mac: {
    ...release.mac,
    // Why: the space in "Orca NP" makes electron-builder publish the zip as
    // `Orca-NP-1.4.214-np.41-mac.zip` but its blockmap as `Orca.NP-1.4.214-np.41-mac.zip.blockmap`
    // — it only swaps spaces for dashes in names GitHub rejects, and the blockmap is written before
    // that swap. The updater asks for `<zip url>.blockmap`, gets a 404 and falls back to a full
    // download, so every macOS update re-downloads the whole app instead of a diff. A name that is
    // already GitHub-safe keeps the two identical. The dmg keeps upstream's name: `dmg.artifactName`
    // is target-specific and wins over this one.
    artifactName: `Orca-NP-\${version}-\${arch}-mac.\${ext}`
  },
  win: {
    ...release.win,
    executableName: productName,
    signtoolOptions,
    verifyUpdateCodeSignature: false,
    extraResources: renameWindowsCli(release.win.extraResources)
  },
  // Why executableName too: deb/rpm payload paths are named after `packager.executableName`, not the
  // package name (app-builder-lib's FpmTarget), so keeping upstream's `orca-ide` here ships
  // /usr/share/applications/orca-ide.desktop, the icon paths and /usr/share/mime/packages/orca-ide.xml
  // — files an official `orca-ide` package already owns, which makes dpkg and rpm refuse the install.
  // The in-bundle CLI launcher keeps its own file name (see resources/linux/bin/orca-ide).
  linux: { ...release.linux, executableName: packageName },
  deb: {
    ...release.deb,
    packageName: cliCommandName,
    artifactName: `${cliCommandName}_\${version}_\${arch}.\${ext}`
  },
  rpm: {
    ...release.rpm,
    packageName: cliCommandName,
    artifactName: `${cliCommandName}-\${version}.\${arch}.\${ext}`
  }
}
