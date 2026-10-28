import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { assertNoCarriageReturnsInSource } from './mobile-web-source-line-endings.mjs'
import {
  MOBILE_WEB_BUNDLE_DIR as defaultBundleDir,
  assertMobileWebBundleBuilt
} from './verify-packaged-mobile-web-bundle.cjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const manifestContract = join(
  projectDir,
  'src',
  'shared',
  'mobile-web-bundle',
  'manifest-contract.ts'
)

/**
 * The document, the route chunks and the images the route tree imports. Derived rather than
 * pinned, because a flat number stops agreeing with the chunk ceiling as routes are added: at 128
 * and 49 images, 18 routes are already allowed 103 chunks, and 103 + 49 + 1 is 153, so the asset
 * count would have failed first and named the count rather than the split that caused it. Written
 * as chunks + images + the document, a bundle at the chunk ceiling sits exactly at this one, so
 * the chunk ceiling always trips first and the failure says what actually grew.
 */
export function mobileWebAppBundleMaxAssets(routeCount, imageCount) {
  return mobileWebAppBundleMaxChunks(routeCount) + imageCount + 1
}

/**
 * Phase C byte budget for the app bundle, not the contract ceiling (10 MiB per asset,
 * MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES). Deliberately below it so growth trips a build rather than a
 * refused asset on a phone. Splitting barely moves it — the same code is emitted in more files —
 * so shrinking this still means cutting code.
 *
 * This head reads 7,960,086 bytes of the 9,437,184 here, 84.4%, leaving 1,477,098. A reading and
 * not a pin: nothing asserts it, because the number moves with every build. It is here so the
 * generation that spends the rest can see it was already this close.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES = 9 * 1024 * 1024

// Only this licensed desktop-identical asset has its own allowance; code retains the 9 MiB fence.
export const MOBILE_WEB_APP_TERMINAL_FONT_MAX_BYTES = 1200 * 1024
const TERMINAL_FONT_SHA256 = '8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467'
const TERMINAL_FONT_BYTES = 1_177_916

export function mobileWebAppBundleBudgetBytes(manifest) {
  const fonts = manifest.assets.filter(
    (asset) => asset.path.endsWith('.woff2') || asset.contentType.startsWith('font/')
  )
  if (fonts.length > 1) {
    fail('only one licensed terminal font may use the independent font allowance')
  }
  const font = fonts[0]
  if (!font) {
    return manifest.totalBytes
  }
  if (
    font.path !== `assets/${TERMINAL_FONT_SHA256}.woff2` ||
    font.sha256 !== TERMINAL_FONT_SHA256 ||
    font.contentType !== 'font/woff2' ||
    font.byteLength !== TERMINAL_FONT_BYTES ||
    font.byteLength > MOBILE_WEB_APP_TERMINAL_FONT_MAX_BYTES
  ) {
    fail(
      'terminal font allowance requires the approved hash, path, MIME type and bounded byte length'
    )
  }
  return manifest.totalBytes - font.byteLength
}

// Measure sorted route prefixes with routes.slice(0,n): distinct importer sets determine chunks, not route count.
// Re-measure table when routes change; it is envelope’s only input, and pins must fail rather than permit arbitrary ceiling bumps.
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP = [
  ['./_layout.tsx', 3],
  ['./h/[hostId]/[...page].tsx', 7],
  ['./h/[hostId]/accounts.tsx', 11],
  ['./h/[hostId]/agent-history/[worktreeId].tsx', 16],
  ['./h/[hostId]/edit.tsx', 21],
  ['./h/[hostId]/files/[worktreeId].tsx', 25],
  ['./h/[hostId]/files/preview/[worktreeId].tsx', 32],
  ['./h/[hostId]/history/[worktreeId].tsx', 35],
  ['./h/[hostId]/index.tsx', 42],
  ['./h/[hostId]/new-workspace.tsx', 51],
  ['./h/[hostId]/pr/[worktreeId].tsx', 52],
  ['./h/[hostId]/review/[worktreeId].tsx', 60],
  ['./h/[hostId]/session/[worktreeId].tsx', 72],
  ['./h/[hostId]/source-control/[worktreeId].tsx', 77],
  ['./h/[hostId]/tasks.tsx', 92],
  ['./h/_layout.tsx', 96]
]

const sweptScripts = MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.map(([, scripts]) => scripts)

// Marginal script cost per added route defines measured envelope’s worst-case slope.
export const MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD = sweptScripts
  .slice(1)
  .map((scripts, index) => scripts - sweptScripts[index])

// Allow four chunks of measured refactor-only drift per head, never cumulative; larger change requires fresh sweep rather than inflated margin.
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN = 4

// Ceiling is swept maximum+margin, flat below sweep length, growing by worst measured route beyond it; test both excess and unused headroom.
// Route count remains sole term: deferred engine must be one artifact, not admit mermaid’s 103 diagram chunks through a new allowance. Entry closure budget below catches collapsed splitting.
export function mobileWebAppBundleMaxChunks(routeCount) {
  const beyondTheSweep = Math.max(0, routeCount - MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.length)
  return (
    sweptScripts.at(-1) +
    MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN +
    Math.max(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD) * beyondTheSweep
  )
}

// Bound entry/static-import closure before first paint: dropping splitting or statically importing a route can ship slow first-open.
// Expo-router needs synchronous unstable_settings only on layouts; re-measure budget before making another route static, not as a per-route escape hatch.
export const MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES = 3 * 1024 * 1024

/** Every tree whose bytes reach the buildId, so a CRLF checkout cannot fork it. */
export const MOBILE_WEB_APP_SOURCE_DIRS = [
  join(projectDir, 'mobile', 'web-entry'),
  join(projectDir, 'mobile', 'app'),
  join(projectDir, 'mobile', 'src')
]

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message)
}

// Load phone’s manifest asset ceiling from contract through esbuild, which resolves extensionless TS imports; never copy native shell count.
export async function readMobileWebBundleMaxAssets() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [manifestContract],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const source = Buffer.from(outputFiles[0].contents).toString('base64')
  const { MOBILE_WEB_BUNDLE_MAX_ASSETS: ceiling } = await import(
    `data:text/javascript;base64,${source}`
  )
  if (typeof ceiling !== 'number') {
    fail(`${manifestContract} exports no MOBILE_WEB_BUNDLE_MAX_ASSETS to bound the build with`)
  }
  return ceiling
}

/**
 * The derived ceiling is only a budget while it stays inside the map the phone can hold: the
 * shells return null for a manifest over MOBILE_WEB_BUNDLE_MAX_ASSETS rather than dropping the
 * extra assets, so a route count that pushes the chunk envelope plus images plus the document past
 * it would pass this build and fail on the device with nothing to read. At today's 49 images that
 * is 29 routes, inside what Phase C adds, which is why this is a build failure and not a comment.
 * The envelope grants the worst swept route to each one past the sweep, so re-measuring a tree
 * whose routes share more moves that crossing out again.
 */
export function assertAssetCeilingFitsShell(routeCount, imageCount, shellMaxAssets) {
  const ceiling = mobileWebAppBundleMaxAssets(routeCount, imageCount)
  if (ceiling > shellMaxAssets) {
    fail(
      `the ceiling derived for ${String(routeCount)} route(s) and ${String(imageCount)} image(s) ` +
        `is ${String(ceiling)} assets, over the ${String(shellMaxAssets)} the shell will load`
    )
  }
  return ceiling
}

async function buildIntoScratch() {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-verify-'))
  try {
    return await buildMobileWebAppBundle({ outDir: join(scratch, 'mobile-web') })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// bundleDir is a seam for the tests, which verify a scratch build; the script always verifies out/.
export async function verifyMobileWebAppBundle({ bundleDir = defaultBundleDir } = {}) {
  for (const directory of MOBILE_WEB_APP_SOURCE_DIRS) {
    await assertNoCarriageReturnsInSource(directory)
  }

  const manifest = assertMobileWebBundleBuilt(bundleDir)

  const budgetBytes = mobileWebAppBundleBudgetBytes(manifest)
  if (budgetBytes > MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES) {
    fail(
      `bundle excluding the approved font is ${String(budgetBytes)} bytes, over the Phase C budget of ` +
        `${String(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)}`
    )
  }

  const first = await buildIntoScratch()
  const second = await buildIntoScratch()
  if (first.manifest.buildId !== second.manifest.buildId) {
    fail(`buildId is not reproducible: ${first.manifest.buildId} then ${second.manifest.buildId}`)
  }
  if (first.manifest.buildId !== manifest.buildId) {
    fail(
      `${bundleDir} is stale: it carries buildId ${manifest.buildId}, a fresh build produces ${first.manifest.buildId}`
    )
  }
  // Read chunk/entry bounds and image count from fresh verified build: they are not manifest fields, while buildId binds on-disk bytes.
  const maxAssets = assertAssetCeilingFitsShell(
    first.routeKeys.length,
    first.imageCount,
    await readMobileWebBundleMaxAssets()
  )
  if (manifest.assets.length > maxAssets) {
    fail(
      `bundle has ${String(manifest.assets.length)} assets, over the Phase C budget of ` +
        `${String(maxAssets)} for ${String(first.routeKeys.length)} route(s) and ` +
        `${String(first.imageCount)} image(s)`
    )
  }
  const maxChunks = mobileWebAppBundleMaxChunks(first.routeKeys.length)
  if (first.chunkCount > maxChunks) {
    fail(
      `bundle is cut into ${String(first.chunkCount)} chunks, over the Phase C budget of ` +
        `${String(maxChunks)} for ${String(first.routeKeys.length)} route(s)`
    )
  }
  if (first.entryStaticBytes > MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES) {
    fail(
      `${String(first.entryStaticBytes)} bytes load before the first route, over the Phase C ` +
        `budget of ${String(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)}`
    )
  }
  return manifest
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    const manifest = await verifyMobileWebAppBundle()
    console.log(
      `[verify-mobile-web-app-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
        `${String(manifest.totalBytes)} total bytes, ` +
        `${String(mobileWebAppBundleBudgetBytes(manifest))}/${String(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)} bytes excluding the approved font, ` +
        `reproducible buildId ${manifest.buildId}`
    )
  } catch (error) {
    console.error(`[verify-mobile-web-app-bundle] ${error.message}`)
    process.exit(1)
  }
}
