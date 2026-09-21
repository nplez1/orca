@testable import OrcaComputerUseMacOSCore
import XCTest

final class OrcaBundleIdentityTests: XCTestCase {
    func testHelperBundleIdSitsInTheAppNamespace() {
        XCTAssertEqual(
            OrcaBundleIdentity.computerUseBundleId,
            "\(OrcaBundleIdentity.appId).computer-use"
        )
    }

    func testTrustsTheAppAndItsDevBundles() {
        XCTAssertTrue(OrcaBundleIdentity.isTrustedPeer(bundleId: OrcaBundleIdentity.appId))
        XCTAssertTrue(OrcaBundleIdentity.isTrustedPeer(bundleId: OrcaBundleIdentity.devBundleId))
        XCTAssertTrue(
            OrcaBundleIdentity.isTrustedPeer(bundleId: "\(OrcaBundleIdentity.devBundleId).helper")
        )
        // Why: an unpackaged run is the stock Electron binary, whose bundle id is Electron's own.
        XCTAssertTrue(OrcaBundleIdentity.isTrustedPeer(bundleId: "com.github.Electron"))
    }

    func testRejectsForeignAppsAndThePreRenameIdentity() {
        XCTAssertFalse(OrcaBundleIdentity.isTrustedPeer(bundleId: nil))
        XCTAssertFalse(OrcaBundleIdentity.isTrustedPeer(bundleId: "com.example.orca"))
        // The identity this fork shipped before the rename: a stale helper must not authorize it.
        XCTAssertFalse(OrcaBundleIdentity.isTrustedPeer(bundleId: "com.stablyai.orca"))
        XCTAssertFalse(OrcaBundleIdentity.isTrustedPeer(bundleId: "com.stablyai.orca.dev.abc123"))
    }
}
