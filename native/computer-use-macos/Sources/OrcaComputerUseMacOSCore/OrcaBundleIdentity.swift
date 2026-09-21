import Foundation

/// The identity this fork ships under, in one place.
///
/// Every value here has a twin outside Swift: `ORCA_APP_ID` in
/// `src/shared/local-build-compatibility.ts` and `COMPUTER_USE_BUNDLE_ID` in
/// `config/scripts/computer-use-bundle-identity.mjs`, both pinned by
/// `config/scripts/computer-use-bundle-identity.test.mjs`.
public enum OrcaBundleIdentity {
    public static let appId = "com.nplez1.orca"
    public static let devBundleId = "\(appId).dev"
    public static let computerUseBundleId = "\(appId).computer-use"

    /// Why: an unpackaged run is `com.github.Electron` — Playwright launches the stock Electron
    /// binary, so the dev harness peer is not Orca-named. Same caveat as
    /// `isOrcaPreferencesDomain` in src/main/macos-press-and-hold-default.ts.
    private static let unpackagedHarnessBundleId = "com.github.Electron"

    /// Whether an Orca-owned process may drive this helper over its socket.
    public static func isTrustedPeer(bundleId: String?) -> Bool {
        guard let bundleId else {
            return false
        }
        // `devBundleId` is a per-worktree app; `.dev.` covers its helper and wrapper bundles.
        return bundleId == appId
            || bundleId == devBundleId
            || bundleId.hasPrefix("\(devBundleId).")
            || bundleId == unpackagedHarnessBundleId
    }
}
