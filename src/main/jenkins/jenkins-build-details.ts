import type { PRCheckDetail } from '../../shared/github/check-types'
import {
  jenkinsBuildToCheckRunDetails,
  type JenkinsBuildDetailsFailureReason,
  type JenkinsBuildDetailsResult
} from '../../shared/jenkins-check-details'
import { isJenkinsUrlUnderBase, parseJenkinsBuildLocation } from '../../shared/jenkins-urls'
import {
  asRecord,
  normalizeJenkinsState,
  readArray,
  readString
} from '../../shared/jenkins-payload'
import { jenkinsGetJson, type JenkinsRequestFailure } from './jenkins-request'
import { findJenkinsServerForUrl, readJenkinsServerToken } from './jenkins-server-store'

/**
 * Read one Jenkins build as provider-neutral check details.
 *
 * Three rounds of GETs: `api/json` for the build, `wfapi/describe` for the stage list, then one
 * `wfapi/describe` per stage for its steps and failure text. Every round after the first is
 * best-effort — a freestyle job has no stages, and a stage whose detail fails still renders.
 */

/**
 * Why a cap: a pipeline can have hundreds of stages, and the pane only lists the running and
 * failed few. Failed and in-progress stages are fetched first, so the cap hides only the steps of
 * a pipeline's later, passing stages — those render as leaves. Beyond the cap, a failure message
 * is reachable only by opening the build in Jenkins.
 */
const MAX_STAGE_DETAIL_REQUESTS = 40
/** Jenkins answers stage describes quickly, but a fan-out of hundreds would burst the server. */
const STAGE_DETAIL_CONCURRENCY = 6
/**
 * How long the stage-detail fan-out may extend the read.
 *
 * Why a budget on top of the per-request timeout: the renderer gives up at 25s, so a slow server
 * must not turn an otherwise-fine build into a timeout. Whatever arrived by the deadline is used.
 */
const STAGE_DETAIL_BUDGET_MS = 4_000

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) {
        return
      }
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

type StageDetailTarget = { index: number; url: string; state: string | null }

function readStageDetailTargets(
  stagesBody: unknown,
  buildUrl: string,
  scopeUrl: string
): {
  targets: StageDetailTarget[]
  total: number
} {
  const stages = readArray(asRecord(stagesBody)?.stages)
  const targets: StageDetailTarget[] = []
  stages.forEach((raw, index) => {
    const stage = asRecord(raw)
    const href = readString(asRecord(asRecord(stage?._links)?.self)?.href)
    if (!href) {
      return
    }
    let resolved: string
    try {
      resolved = new URL(href, buildUrl).toString()
    } catch {
      return
    }
    if (!isJenkinsUrlUnderBase(scopeUrl, resolved)) {
      return
    }
    targets.push({ index, url: resolved, state: normalizeJenkinsState(stage?.status) })
  })
  return { targets, total: stages.length }
}

/** A stage whose detail the failure summary and tree want first: anything not a clean pass. */
function isWorthFetchingFirst(state: string | null): boolean {
  return state === null || (state !== 'SUCCESS' && state !== 'NOT_EXECUTED' && state !== 'SKIPPED')
}

async function readStageDetails(args: {
  stagesBody: unknown
  buildUrl: string
  /** Bound for server-supplied hrefs: the configured server prefix, or the build's own origin. */
  scopeUrl: string
  request: Omit<Parameters<typeof jenkinsGetJson>[0], 'url'>
}): Promise<unknown[] | undefined> {
  const { targets, total } = readStageDetailTargets(args.stagesBody, args.buildUrl, args.scopeUrl)
  if (targets.length === 0) {
    return undefined
  }
  const prioritized = [
    ...targets.filter((target) => isWorthFetchingFirst(target.state)),
    ...targets.filter((target) => !isWorthFetchingFirst(target.state))
  ].slice(0, MAX_STAGE_DETAIL_REQUESTS)

  const details: unknown[] = Array.from({ length: total }, () => null)
  const deadline = Date.now() + STAGE_DETAIL_BUDGET_MS
  let budgetTimer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>((resolve) => {
    budgetTimer = setTimeout(resolve, STAGE_DETAIL_BUDGET_MS)
  })
  try {
    await Promise.race([
      mapWithConcurrency(prioritized, STAGE_DETAIL_CONCURRENCY, async (target) => {
        if (Date.now() >= deadline) {
          return
        }
        const response = await jenkinsGetJson({ ...args.request, url: target.url })
        details[target.index] = response.ok ? response.body : null
      }),
      budget
    ])
  } finally {
    clearTimeout(budgetTimer)
  }
  return details
}

/** Only the fields the mapper reads, so a matrix build's `actions` cannot balloon the response. */
const JENKINS_BUILD_TREE = [
  'number',
  'building',
  'result',
  'displayName',
  'fullDisplayName',
  'description',
  'url',
  'timestamp',
  'duration',
  'estimatedDuration',
  'actions[_class,causes[_class,shortDescription],parameters[_class,name,value]]',
  'changeSets[items[commitId,msg,comment,author[fullName]]]'
].join(',')

function fail(
  reason: JenkinsBuildDetailsFailureReason,
  serverUrl: string | null,
  message: string | null
): JenkinsBuildDetailsResult {
  return { ok: false, reason, serverUrl, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A build payload always carries a number and a building flag; a random JSON API does not. */
function looksLikeJenkinsBuild(body: unknown): boolean {
  const record = asRecord(body)
  return typeof record?.number === 'number' && typeof record.building === 'boolean'
}

/**
 * Decide how much authority to give a failed request.
 *
 * With a configured server the answer is authoritative. Without one we are guessing from a URL
 * shape, so anything that could equally be "this URL is not Jenkins" degrades to `not-jenkins` and
 * lets the caller fall back to its own provider path — the difference between an empty pane and a
 * wrong one.
 */
function resolveFailure(
  failure: JenkinsRequestFailure,
  serverUrl: string,
  configured: boolean
): JenkinsBuildDetailsResult {
  if (configured || failure.identifiedAsJenkins) {
    return fail(failure.reason, serverUrl, failure.message)
  }
  switch (failure.reason) {
    case 'unauthorized':
    case 'forbidden':
      // Jenkins answered and wanted credentials we do not have for it.
      return fail('not-configured', serverUrl, failure.message)
    case 'not-found':
    case 'not-jenkins':
    case 'error':
      return fail('not-jenkins', serverUrl, failure.message)
    // A timeout or a transport failure is real information whatever the host turns out to be.
    case 'timeout':
    case 'unreachable':
    case 'not-configured':
      return fail(failure.reason, serverUrl, failure.message)
  }
}

export async function getJenkinsBuildDetails(args: {
  url: string
  check: Pick<PRCheckDetail, 'name' | 'status' | 'conclusion' | 'url'>
  signal?: AbortSignal
}): Promise<JenkinsBuildDetailsResult> {
  const location = parseJenkinsBuildLocation(args.url)
  if (!location) {
    return fail('not-jenkins', null, null)
  }
  const server = findJenkinsServerForUrl(args.url)
  let apiToken: string | null = null
  if (server) {
    try {
      apiToken = readJenkinsServerToken(server.id)
    } catch (error) {
      // A keychain denial is an auth problem the user can act on, not an unreachable server.
      return fail('unauthorized', location.serverUrl, errorMessage(error))
    }
  }

  const request = {
    username: server?.username ?? '',
    apiToken,
    configured: server !== null,
    serverBaseUrl: server?.baseUrl ?? null,
    ...(args.signal ? { signal: args.signal } : {})
  }
  const buildResponse = await jenkinsGetJson({
    ...request,
    url: `${location.buildUrl}api/json?tree=${JENKINS_BUILD_TREE}`
  })
  if (!buildResponse.ok) {
    return resolveFailure(buildResponse.failure, location.serverUrl, server !== null)
  }
  // Why for both cases: a configured server answering with something that is not a build is a
  // broken Jenkins or a proxy wearing its URL, and rendering that as an empty pane is the bug this
  // feature removes. An unconfigured host gets the benefit of the doubt and falls through.
  if (!looksLikeJenkinsBuild(buildResponse.body)) {
    return server === null
      ? fail('not-jenkins', location.serverUrl, null)
      : fail('error', location.serverUrl, 'Jenkins answered with something that is not a build')
  }

  const stagesResponse = await jenkinsGetJson({
    ...request,
    url: `${location.buildUrl}wfapi/describe`
  })
  const stageDetails = stagesResponse.ok
    ? await readStageDetails({
        stagesBody: stagesResponse.body,
        buildUrl: location.buildUrl,
        scopeUrl: server?.baseUrl ?? location.serverUrl,
        request
      })
    : undefined
  return {
    ok: true,
    details: jenkinsBuildToCheckRunDetails({
      check: args.check,
      location,
      build: buildResponse.body,
      stages: stagesResponse.ok ? stagesResponse.body : null,
      ...(stageDetails ? { stageDetails } : {})
    })
  }
}
