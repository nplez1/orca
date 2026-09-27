/**
 * Where a Jenkins link points, and which configured server serves it.
 *
 * A Jenkins check reaches the Checks panel as a GitHub legacy commit status: a name, a
 * state and a `target_url`, with no run identifier. That URL is therefore the only handle
 * we get, and both halves of the feature depend on reading it correctly — deriving the
 * classic build URL the REST API is addressed by, and choosing which server's credentials
 * to send.
 */

/** Blue Ocean packs a folder path into one segment; a nested `/job/` becomes `%2F` there. */
const BLUE_OCEAN_FOLDER_SEPARATOR = /%2f/gi
const DOUBLE_ENCODED_FOLDER_SEPARATOR = /%252f/gi

const CLASSIC_PERMALINKS = new Set([
  'lastBuild',
  'lastCompletedBuild',
  'lastFailedBuild',
  'lastStableBuild',
  'lastSuccessfulBuild',
  'lastUnstableBuild',
  'lastUnsuccessfulBuild'
])

export type JenkinsBuildLocation = {
  /** Origin plus any path prefix Jenkins is served under, without a trailing slash. */
  serverUrl: string
  /** Classic job URL ending in `/` — the parent of every build below it. */
  jobUrl: string
  /** Classic build URL ending in `/`, ready for `api/json` and `wfapi/describe`. */
  buildUrl: string
  /** URL-decoded job path segments, e.g. `['team', 'repo', 'main']` for a multibranch job. */
  jobPath: string[]
  /** Numeric build number, or null when the URL names a build by alias. */
  buildNumber: number | null
  /** Build alias the URL resolved to; `lastBuild` when it pointed at the job rather than a build. */
  permalink: string | null
}

function parseUrl(input: string | null | undefined): URL | null {
  const trimmed = input?.trim()
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  return url
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Malformed percent-escapes are still a usable display label; the raw segment stays in the URL.
    return segment
  }
}

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * Normalize a user-entered Jenkins base URL to the prefix form used for matching.
 * Returns null for anything that is not an http(s) URL.
 */
export function normalizeJenkinsBaseUrl(input: string | null | undefined): string | null {
  const url = parseUrl(input)
  if (!url) {
    return null
  }
  const path = stripTrailingSlashes(url.pathname)
  return `${url.origin}${path}`
}

/**
 * Whether `url` is served by the server configured as `baseUrl`, comparing on path-segment
 * boundaries so `https://host/jenkins` never claims `https://host/jenkins-old`.
 *
 * Prefix rather than origin because Jenkins is routinely path-prefixed, and two instances can
 * share one host.
 */
export function isJenkinsUrlUnderBase(baseUrl: string, url: string): boolean {
  const base = parseUrl(baseUrl)
  const target = parseUrl(url)
  if (!base || !target || base.origin !== target.origin) {
    return false
  }
  const basePath = stripTrailingSlashes(base.pathname)
  if (basePath === '') {
    return true
  }
  const targetPath = stripTrailingSlashes(target.pathname)
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`)
}

/**
 * The path prefix Jenkins is served under plus the Blue Ocean route after the organization,
 * or null when the URL is not a Blue Ocean link.
 *
 * The `/blue` mount sits *under* any path prefix, so a server at `https://host/jenkins` serves
 * `https://host/jenkins/blue/organizations/…` and the prefix has to be carried into the classic
 * job URL we derive.
 */
function blueOceanRoute(url: URL): { pathPrefix: string; segments: string[] } | null {
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  const blueIndex = segments.indexOf('blue')
  if (
    blueIndex === -1 ||
    segments[blueIndex + 1] !== 'organizations' ||
    segments.length < blueIndex + 5
  ) {
    return null
  }
  return {
    pathPrefix: stripTrailingSlashes(`/${segments.slice(0, blueIndex).join('/')}`),
    // Skip `blue/organizations/<org>`; the rest is the pipeline route.
    segments: segments.slice(blueIndex + 3)
  }
}

/**
 * Blue Ocean packs folder paths into a single segment. Split them back out so a job nested in
 * folders resolves to the same classic job path a non-Blue-Ocean link would.
 */
function decodeFolderPath(raw: string): string[] {
  const normalized = raw.replace(DOUBLE_ENCODED_FOLDER_SEPARATOR, '%2F')
  return normalized.split(BLUE_OCEAN_FOLDER_SEPARATOR).map(decodeSegment)
}

function segmentAfter(segments: string[], marker: string): string | null {
  const index = segments.indexOf(marker)
  return index === -1 ? null : (segments[index + 1] ?? null)
}

/**
 * Assemble a location from a path prefix plus the job-name segments *as they must appear in the
 * URL*, so a decoded name has to be encoded by the caller and an already-encoded one must not be.
 */
function toLocation(
  url: URL,
  pathPrefix: string,
  rawJobNames: string[],
  buildRef: string
): JenkinsBuildLocation | null {
  if (rawJobNames.length === 0) {
    return null
  }
  const numeric = /^\d+$/.test(buildRef)
  const buildNumber = numeric ? Number(buildRef) : null
  const permalink = numeric
    ? null
    : CLASSIC_PERMALINKS.has(buildRef)
      ? buildRef
      : // Why: a job-level link names no build, so read the newest one rather than nothing.
        'lastBuild'
  const resolvedRef = buildNumber === null ? permalink! : buildRef
  const jobUrl = `${url.origin}${pathPrefix}/${rawJobNames.map((name) => `job/${name}`).join('/')}/`
  return {
    serverUrl: `${url.origin}${pathPrefix}`,
    jobUrl,
    buildUrl: `${jobUrl}${encodeURIComponent(resolvedRef)}/`,
    jobPath: rawJobNames.map(decodeSegment),
    buildNumber,
    permalink
  }
}

/** The common shape: `…/job/<name>/job/<name>/<build>/<page…>`, with anything before `/job/` a prefix. */
function parseClassicLocation(url: URL): JenkinsBuildLocation | null {
  const jobIndex = url.pathname.indexOf('/job/')
  if (jobIndex === -1) {
    return null
  }
  const pathPrefix = stripTrailingSlashes(url.pathname.slice(0, jobIndex))
  const segments = url.pathname
    .slice(jobIndex + 1)
    .split('/')
    .filter((segment) => segment.length > 0)

  // Greedily consume `job/<name>` pairs: a job already called "lastBuild" is a name, not an alias.
  const rawJobNames: string[] = []
  let index = 0
  while (segments[index] === 'job' && segments[index + 1] !== undefined) {
    rawJobNames.push(segments[index + 1])
    index += 2
  }
  if (rawJobNames.length === 0) {
    return null
  }
  // Everything past the build reference is a page (console/artifact/changes/…) we do not need.
  return toLocation(url, pathPrefix, rawJobNames, segments[index] ?? 'lastBuild')
}

/**
 * Blue Ocean links, translated to their classic equivalent because `api/json` and
 * `wfapi/describe` only exist on the classic job path.
 *
 * Best-effort: Blue Ocean does not distinguish a non-multibranch pipeline from a branch in its
 * `/detail/<name>/` route, so a wrong guess degrades to a classified "not found" rather than
 * wrong data.
 */
function parseBlueOceanLocation(url: URL): JenkinsBuildLocation | null {
  const route = blueOceanRoute(url)
  if (!route) {
    return null
  }
  const { pathPrefix, segments } = route
  const usesRestRoute = segments[0] === 'pipelines'
  const rawPipeline = usesRestRoute ? segments[1] : segments[0]
  if (!rawPipeline) {
    return null
  }

  const names = decodeFolderPath(rawPipeline)
  const detail = usesRestRoute ? null : segmentAfter(segments, 'detail')
  const branch = detail ?? segmentAfter(segments, 'branches')
  const runId = usesRestRoute
    ? segmentAfter(segments, 'runs')
    : detail
      ? (segments[segments.indexOf('detail') + 2] ?? null)
      : null

  if (branch) {
    const decodedBranch = decodeSegment(branch)
    // Why: a non-multibranch pipeline repeats its own name in `/detail/`; anything else is a branch.
    if (decodedBranch !== names.at(-1)) {
      names.push(decodedBranch)
    }
  }

  // Decoded above for display, so re-encode for the classic URL.
  return toLocation(
    url,
    pathPrefix,
    names.map((name) => encodeURIComponent(name)),
    runId ?? 'lastBuild'
  )
}

/**
 * Read a Jenkins link's build location, or null when the link is not a Jenkins build at all.
 *
 * A non-null result is a candidate, not proof: the caller confirms by fetching. That keeps a
 * false positive (any URL containing `/job/<x>/<n>`) to one wasted request that resolves to a
 * classified "not a build" instead of the empty details pane this feature exists to remove.
 */
export function parseJenkinsBuildLocation(
  input: string | null | undefined
): JenkinsBuildLocation | null {
  const url = parseUrl(input)
  if (!url) {
    return null
  }
  return parseBlueOceanLocation(url) ?? parseClassicLocation(url)
}
