import type {
  PRCheckDetail,
  PRCheckJob,
  PRCheckRunDetails,
  PRCheckStep
} from './github/check-types'
import type { JenkinsBuildLocation } from './jenkins-urls'
import { readJenkinsBuildMetadata } from './jenkins-build-metadata'
import {
  asRecord,
  isoFromMs,
  normalizeJenkinsState,
  readArray,
  readFiniteNumber,
  readString
} from './jenkins-payload'

/**
 * Jenkins build payloads adapted to the provider-neutral check-details shape the Checks pane and
 * the full-details tab already render.
 *
 * Jenkins reports a build and its stages through two endpoints whose field names and status
 * vocabularies differ from GitHub's, so everything provider-specific stops here:
 * `<build>/api/json` for the build (metadata in `jenkins-build-metadata.ts`), and
 * `<build>/wfapi/describe` for the stage list — absent on freestyle jobs, where a build has no
 * stages at all.
 */

export type JenkinsBuildDetailsFailureReason =
  /** The link is not a Jenkins build, so the caller should fall back to its own provider path. */
  | 'not-jenkins'
  /** Jenkins, but no server is configured for it, so there are no credentials to read the build. */
  | 'not-configured'
  | 'not-found'
  /** Credentials were rejected, or an SSO login page came back instead of the API. */
  | 'unauthorized'
  /** Authenticated, but this account cannot read the job. */
  | 'forbidden'
  | 'unreachable'
  | 'timeout'
  | 'error'

export type JenkinsBuildDetailsResult =
  | { ok: true; details: PRCheckRunDetails }
  | {
      ok: false
      reason: JenkinsBuildDetailsFailureReason
      /** Origin of the Jenkins the check pointed at, so copy can name the server to add. */
      serverUrl: string | null
      /** Provider or transport detail, classified for logs; the renderer localizes its own copy. */
      message: string | null
    }

export type JenkinsBuildCheckDetailsInput = {
  /** The check row being enriched; its state is the authoritative one for the pane. */
  check: Pick<PRCheckDetail, 'name' | 'status' | 'conclusion' | 'url'>
  /** Links and the fallback display name, from the parsed check URL. */
  location: Pick<JenkinsBuildLocation, 'jobPath' | 'buildUrl'>
  /** `<build>/api/json` payload. */
  build: unknown
  /** `<build>/wfapi/describe` payload, or null when the job has no stages (freestyle). */
  stages: unknown
}

/** Jenkins results mapped to GitHub's conclusion vocabulary so the pane's classifier keeps working. */
const JENKINS_RESULT_CONCLUSIONS: Record<string, PRCheckDetail['conclusion']> = {
  SUCCESS: 'success',
  // Why `UNSTABLE` is a failure: the build did not fully pass (usually failing tests), and neither
  // `neutral` nor `skipped` — the states that read as "nothing to see" — would send anyone to look.
  FAILURE: 'failure',
  UNSTABLE: 'failure',
  ABORTED: 'cancelled',
  NOT_BUILT: 'skipped'
}

export function mapJenkinsResultToConclusion(result: string | null): PRCheckDetail['conclusion'] {
  return result === null ? null : (JENKINS_RESULT_CONCLUSIONS[result] ?? null)
}

/** Stage states as GitHub step vocabulary; `wfapi` mixes `FAILED` with the build's `FAILURE`. */
const JENKINS_STAGE_STATES: Record<string, Pick<PRCheckStep, 'status' | 'conclusion'>> = {
  SUCCESS: { status: 'completed', conclusion: 'success' },
  FAILED: { status: 'completed', conclusion: 'failure' },
  FAILURE: { status: 'completed', conclusion: 'failure' },
  UNSTABLE: { status: 'completed', conclusion: 'failure' },
  ABORTED: { status: 'completed', conclusion: 'cancelled' },
  NOT_EXECUTED: { status: 'completed', conclusion: 'skipped' },
  SKIPPED: { status: 'completed', conclusion: 'skipped' },
  // Why: a stage waiting on input is blocking a human, which is what action_required means here —
  // and it has not completed, so its status says so.
  PAUSED_PENDING_INPUT: { status: 'in_progress', conclusion: 'action_required' },
  PAUSED: { status: 'in_progress', conclusion: 'action_required' },
  IN_PROGRESS: { status: 'in_progress', conclusion: 'pending' },
  QUEUED: { status: 'queued', conclusion: 'pending' }
}

function mapJenkinsStageState(state: string | null): Pick<PRCheckStep, 'status' | 'conclusion'> {
  if (state === null) {
    return { status: 'completed', conclusion: null }
  }
  return JENKINS_STAGE_STATES[state] ?? { status: 'completed', conclusion: null }
}

/**
 * Statuses that mean the stage will not run further.
 *
 * Why this gate: `wfapi` reports `durationMillis` as *elapsed* time while a stage is still running
 * or waiting on input, so adding it to the start time would claim a completion that has not happened.
 */
const TERMINAL_STAGE_STATES = new Set([
  'SUCCESS',
  'FAILED',
  'FAILURE',
  'UNSTABLE',
  'ABORTED',
  'NOT_EXECUTED',
  'SKIPPED'
])

function readStage(raw: unknown): PRCheckStep | null {
  const stage = asRecord(raw)
  const name = readString(stage?.name)
  if (!stage || !name) {
    return null
  }
  const state = normalizeJenkinsState(stage.status)
  const startedMs = readFiniteNumber(stage.startTimeMillis)
  const durationMs = readFiniteNumber(stage.durationMillis)
  const completedAt =
    state !== null && TERMINAL_STAGE_STATES.has(state) && startedMs !== null && durationMs !== null
      ? isoFromMs(startedMs + durationMs)
      : null
  return {
    name,
    ...mapJenkinsStageState(state),
    startedAt: isoFromMs(startedMs),
    completedAt
  }
}

function readStepList(stages: unknown): PRCheckStep[] {
  return readArray(asRecord(stages)?.stages)
    .map(readStage)
    .filter((stage): stage is PRCheckStep => stage !== null)
}

export function jenkinsBuildToCheckRunDetails(
  input: JenkinsBuildCheckDetailsInput
): PRCheckRunDetails {
  const build = asRecord(input.build)
  const workflow = asRecord(input.stages)
  const steps = readStepList(input.stages)

  const number = readFiniteNumber(build?.number)
  const building = build?.building === true
  const conclusion: PRCheckDetail['conclusion'] = building
    ? 'pending'
    : mapJenkinsResultToConclusion(normalizeJenkinsState(build?.result))

  // Why wfapi first: api/json's `duration` is 0 until the build finishes, while describe carries
  // the queue and run durations the build page shows.
  const startedMs =
    readFiniteNumber(workflow?.startTimeMillis) ?? readFiniteNumber(build?.timestamp)
  const durationMs = building
    ? null
    : (readFiniteNumber(workflow?.durationMillis) ?? readFiniteNumber(build?.duration))
  const completedMs =
    building || startedMs === null || durationMs === null || durationMs <= 0
      ? null
      : startedMs + durationMs

  const displayName = readString(build?.displayName)
  // Why Jenkins' own `url` first: a check whose link named no build reads `lastBuild`, so the link we
  // show has to be the build we actually read rather than whichever one is newest when it is clicked.
  const buildUrl = readString(build?.url) ?? input.location.buildUrl
  const job: PRCheckJob = {
    id: number,
    name:
      displayName ?? (number !== null ? `#${number}` : null) ?? input.location.jobPath.join(' / '),
    status: building ? 'in_progress' : 'completed',
    conclusion,
    startedAt: isoFromMs(startedMs),
    completedAt: isoFromMs(completedMs),
    url: buildUrl,
    logTail: null,
    steps,
    // Why: a stage list is the build's shape, not a drill-down — the running stage has to be visible.
    ...(steps.length > 0 ? { stepRendering: 'all' as const } : {})
  }

  return {
    name: input.check.name,
    // Why: copying the row's own state keeps the pane's status/conclusion cache invalidation from
    // evicting this entry on every poll tick; Jenkins' own verdict is on the job and stage rows.
    status: input.check.status,
    conclusion: input.check.conclusion,
    url: buildUrl,
    detailsUrl: buildUrl,
    startedAt: isoFromMs(startedMs),
    completedAt: isoFromMs(completedMs),
    title: readString(build?.fullDisplayName) ?? displayName,
    summary: readString(build?.description),
    text: null,
    annotations: [],
    jobs: [job],
    build: readJenkinsBuildMetadata(build, workflow)
  }
}
