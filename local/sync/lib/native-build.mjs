// The post-sync native row: compile every Swift target under native/ the way the macOS release does.
//
// Why: nothing else local compiles Swift. The 2026-11-15 merge took upstream's computer-use `main.swift`,
// which called `TrustedOrcaApplication` — a type the fork had replaced with `OrcaBundleIdentity` — and it
// surfaced only on the CI macOS release leg, six hours later in a 61-minute run. This catches it in ~10 s.
//
// Narrowest compile that still covers the release: a host-arch debug `swift build` of each SwiftPM
// package (the release builds the same targets in release mode, per arch, then lipo and codesign), and
// `swiftc -typecheck` of each single-file helper at the release's deployment target. Discovered rather
// than listed, so a helper upstream adds is compiled before the release leg meets it.
//
// What this cannot catch, and the release leg still can: a link or `-sectcreate` failure (helpers are
// typechecked, not linked), a non-host arch, and arch- or DEBUG-conditional code. Nothing carries any
// of those today; if one is added, this row is no longer a proxy for that leg.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { withPassCache } from './pass-cache.mjs'
import { STATUS, repoRoot, run, syncOutputDir, tailText } from './run.mjs'

export const NATIVE_DIR = 'native'
// The `-target` the release's helper scripts pass (config/scripts/native-build/macos/).
const HELPER_DEPLOYMENT_TARGET = '11.0'

/** `[{ kind: 'package' | 'helper', dir }]` for every Swift build root under `native/`. */
export function swiftBuildRoots(entries, has) {
  const roots = []
  for (const dir of [...entries].sort()) {
    if (has(dir, 'Package.swift')) {
      roots.push({ kind: 'package', dir })
    } else if (has(dir, 'main.swift')) {
      roots.push({ kind: 'helper', dir })
    }
  }
  return roots
}

function compile(root, scratch) {
  const source = path.join(repoRoot(), NATIVE_DIR, root.dir)
  if (root.kind === 'package') {
    // The release's build system (build-computer-macos.mjs), so a difference between the two cannot
    // hide a break; the scratch path keeps this out of the release's own `.build` and incremental.
    return run('swift', [
      'build',
      '--package-path',
      source,
      '--scratch-path',
      path.join(scratch, root.dir),
      '--build-system',
      'native'
    ])
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  return run('swiftc', [
    '-typecheck',
    path.join(source, 'main.swift'),
    '-target',
    `${arch}-apple-macosx${HELPER_DEPLOYMENT_TARGET}`
  ])
}

export function nativeMacosBuild(options = {}) {
  if (process.platform !== 'darwin') {
    return {
      status: STATUS.unavailable,
      summary: `Swift compiles only on macOS, and this is ${process.platform}`,
      details: [
        'the CI macOS release leg is then the first compile; waive with --waive native-macos-build:<reason>'
      ]
    }
  }
  const nativeRoot = path.join(repoRoot(), NATIVE_DIR)
  const entries = existsSync(nativeRoot)
    ? readdirSync(nativeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []
  const roots = swiftBuildRoots(entries, (dir, file) =>
    existsSync(path.join(nativeRoot, dir, file))
  )
  if (roots.length === 0) {
    return {
      status: STATUS.failed,
      summary: `no Swift package or main.swift under ${NATIVE_DIR}/`,
      details: ['the release builds Swift helpers from there, so an empty set means they moved']
    }
  }
  const version = run('swift', ['--version'])
  // `/usr/bin/swift` is the xcrun stub without the command line tools: it exits non-zero rather than
  // failing to spawn, so `code === null` would report a good tree as broken.
  if (!version.ok) {
    return {
      status: STATUS.unavailable,
      summary: 'swift is not usable here (install the Xcode command line tools)',
      details: tailText(`${version.stdout}\n${version.stderr}`, 5)
    }
  }
  const sdk = run('xcrun', ['--show-sdk-version'])
  return withPassCache({
    name: 'native-macos-build',
    paths: [NATIVE_DIR],
    // The row's own flags and the SDK are inputs: changing a compile argument must not reuse a pass.
    inputs: {
      roots,
      swift: version.stdout.trim(),
      arch: process.arch,
      sdk: sdk.ok ? sdk.stdout.trim() : null,
      target: HELPER_DEPLOYMENT_TARGET,
      buildSystem: 'native'
    },
    noCache: options.noCache,
    check: () => {
      const scratch = path.join(syncOutputDir(), 'native-build')
      const details = []
      const failed = []
      for (const root of roots) {
        const result = compile(root, scratch)
        details.push(
          `${root.dir} (${root.kind}): ${result.ok ? 'ok' : `FAILED (exit ${result.code ?? 'did not run'})`}`
        )
        if (!result.ok) {
          failed.push(root.dir)
          // Compiler errors are `file:line: error:` lines; the tail is mostly build-plan noise.
          const errors = `${result.stdout}\n${result.stderr}`
            .split('\n')
            .filter((line) => /:\d+:\d+: error: /.test(line))
          details.push(
            ...(errors.length > 0
              ? errors.slice(0, 20)
              : tailText(`${result.stdout}\n${result.stderr}`, 20)
            ).map((line) => `  ${line}`)
          )
        }
      }
      return {
        status: failed.length === 0 ? STATUS.passed : STATUS.failed,
        summary:
          failed.length === 0
            ? `${roots.length} Swift build root(s) compile`
            : `${failed.length} of ${roots.length} Swift build root(s) fail to compile: ${failed.join(', ')}`,
        details
      }
    }
  })
}
