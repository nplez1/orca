// The half of the shard planner's timing baseline that belongs to the fork: the weights for fork-added
// test files, which `ci-shard-timings.json` can never carry.
//
// Why the fork keeps its weights outside the baseline: that file is imported from *upstream* runs, and
// upstream's tree has no fork files, so no refresh can ever add one. Why this is a fork file rather
// than lines inside `readTimingBaseline`: LOCAL-PATCHES.md § Rules asks a fork hook to name an exported
// function in a fork file, so the upstream module keeps a two-line call and an upstream edit to that
// function conflicts with nothing here.
//
// Why the baseline wins a collision: the fork must never re-weight a file upstream measured, and a
// collision means the file reached upstream, so the overlay entry is stale (`--check` reports it).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const OVERLAY_PATH = resolve(import.meta.dirname, 'ci-shard-timings-overlay.json')
const SUITES = ['unit', 'e2e']

/** Why a shape check on the hot path: a typo that still parses is worse than one that throws. */
export function assertOverlayShape(overlay, overlayPath = OVERLAY_PATH) {
  const malformed = (why) => {
    throw new Error(`Malformed shard timing overlay (${why}): ${String(overlayPath)}`)
  }
  if (overlay?.version !== 1) {
    malformed(`version ${JSON.stringify(overlay?.version)}`)
  }
  if (typeof overlay.unit?.timings !== 'object' || overlay.unit.timings === null) {
    malformed('unit.timings is not an object')
  }
  for (const suite of SUITES) {
    const timings = overlay[suite]?.timings
    if (timings === undefined) {
      continue
    }
    if (typeof timings !== 'object' || timings === null || Array.isArray(timings)) {
      malformed(`${suite}.timings is not an object`)
    }
    for (const [file, milliseconds] of Object.entries(timings)) {
      if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
        malformed(`${file} is ${JSON.stringify(milliseconds)}`)
      }
    }
  }
  return overlay
}

/**
 * The baseline for one suite with the overlay merged over it. A missing overlay is the baseline alone,
 * which is what a checkout without one gets; a malformed overlay throws rather than scheduling blind.
 */
export function mergeForkTimingOverlay(suite, baselineBytes, overlayPath = OVERLAY_PATH) {
  const baseline = JSON.parse(baselineBytes)
  if (!existsSync(overlayPath)) {
    return {
      ...baseline[suite],
      baselineSha256: createHash('sha256').update(baselineBytes).digest('hex')
    }
  }
  const overlayBytes = readFileSync(overlayPath, 'utf8')
  const overlay = assertOverlayShape(JSON.parse(overlayBytes), overlayPath)
  return {
    ...baseline[suite],
    timings: { ...overlay[suite]?.timings, ...baseline[suite].timings },
    baselineSha256: createHash('sha256').update(baselineBytes).update(overlayBytes).digest('hex')
  }
}
