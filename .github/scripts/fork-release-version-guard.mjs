// Gate the version a release dispatch stamps, before any artifact is built and before the tag is
// created. The tag this fork publishes is the update feed every installed build reads, so a version
// that cannot be stepped above later strands those installs permanently.
//
// Two ways it can be unsteppable, both from the version string alone:
//
// - Any suffix other than `np.<n>`. Semver compares a pre-release label alphabetically, so `rc.1`
//   on the same base version outranks every `np.<n>` of that base: installs move to it, and nothing
//   published afterwards is ever offered again. `local` sorts below `np`, so a `-local.` build is
//   offered the release on its own base too.
// - A version that is not above the newest published `-np.` tag. `np.<n>` comes from
//   `github.run_number`, which restarts at 1 if this workflow file is renamed or re-created —
//   after which every new release sorts below the newest one and no installed build sees it.
//
// usage: fork-release-version-guard.mjs VERSION [NEWEST-PUBLISHED-TAG]
// exit: 0 publishable, 1 refuse, 2 usage
import { pathToFileURL } from 'node:url'

/** The only shape `fork-release.yml` may stamp: `<base>-np.<run number>`. */
const FORK_RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)-np\.(\d+)$/

/** [major, minor, patch, run] or null. A leading `v` is the tag spelling, not part of the version. */
export function parseForkReleaseVersion(version) {
  const match = FORK_RELEASE_VERSION.exec(
    String(version ?? '')
      .trim()
      .replace(/^v/, '')
  )
  return match ? match.slice(1).map(Number) : null
}

/** Negative when left < right, 0 when equal, positive when left > right, null when either is unusable. */
export function compareForkReleaseVersions(left, right) {
  const leftParts = parseForkReleaseVersion(left)
  const rightParts = parseForkReleaseVersion(right)
  if (!leftParts || !rightParts) {
    return null
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index]
    }
  }
  return 0
}

export function checkForkReleaseVersion(version, newestTag) {
  if (!parseForkReleaseVersion(version)) {
    return {
      ok: false,
      message: `"${version}" is not a publishable release version. The suffix must match ^np\\.[0-9]+$ on a X.Y.Z base: any other pre-release label outranks every np. build of the same base, and this fork's installs would then never be offered a newer release again.`
    }
  }
  if (!newestTag) {
    return { ok: true, message: `${version} is the first release of this line` }
  }
  const comparison = compareForkReleaseVersions(version, newestTag)
  if (comparison === null) {
    return {
      ok: false,
      message: `cannot compare ${version} against the newest published tag "${newestTag}", which is not an X.Y.Z-np.N version`
    }
  }
  if (comparison <= 0) {
    return {
      ok: false,
      message: `${version} is not above the newest published release ${newestTag}. github.run_number restarts at 1 if this workflow is renamed or re-created, and a release below the newest one is offered to nobody: dispatch again with version_suffix set above it.`
    }
  }
  return { ok: true, message: `${version} is above the newest published release ${newestTag}` }
}

function main(argv) {
  const [version, newestTag] = argv
  if (!version || argv.length > 2) {
    process.stderr.write('usage: fork-release-version-guard.mjs VERSION [NEWEST-PUBLISHED-TAG]\n')
    return 2
  }
  const result = checkForkReleaseVersion(version, newestTag)
  if (!result.ok) {
    process.stderr.write(`::error::${result.message}\n`)
    return 1
  }
  process.stdout.write(`${result.message}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
