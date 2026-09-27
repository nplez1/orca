import type { PRCheckBuild, PRCheckBuildCommit, PRCheckBuildParameter } from './github/check-types'
import { asRecord, readArray, readFiniteNumber, readString } from './jenkins-payload'

/**
 * The build-level facts Jenkins reports that have no home in the GitHub-shaped check fields:
 * build number, queue and estimated duration, what started it, its parameters and its commits.
 */

/** Jenkins change sets hold every commit since the last build; the pane lists the recent few. */
const MAX_COMMITS = 5
/** Parameters are usually a handful; a bounded list keeps a matrix job from flooding the pane. */
const MAX_PARAMETERS = 20

const SECRET_PARAMETER_KIND_RE = /password|secret|credential/i

/**
 * Why a name heuristic on top of the kind: a secret is routinely passed as a plain
 * `StringParameterValue` (`DEPLOY_KEY`, `npm_token`, `privateKey`), and Jenkins itself returns it.
 *
 * Matched on word segments rather than substrings, so `MONKEY_COUNT` stays visible while
 * `SSH_KEY` does not, and camelCase is split first so `privateKey` is caught.
 */
const SECRET_PARAMETER_WORDS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cert',
  'certificate',
  'credential',
  'credentials',
  'key',
  'passphrase',
  'passwd',
  'password',
  'pin',
  'private',
  'pwd',
  'salt',
  'secret',
  'signature',
  'signing',
  'token'
])
const SECRET_PARAMETER_JOINED_RE =
  /(password|passwd|secret|token|apikey|privatekey|accesskey|sshkey|credential|passphrase)/

function parameterNameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase())
}

export function isSecretParameterName(name: string): boolean {
  const segments = parameterNameSegments(name)
  return (
    segments.some((segment) => SECRET_PARAMETER_WORDS.has(segment)) ||
    SECRET_PARAMETER_JOINED_RE.test(segments.join(''))
  )
}

function findActionByClassSuffix(
  build: Record<string, unknown> | null,
  suffix: string
): Record<string, unknown>[] {
  return readArray(build?.actions)
    .map(asRecord)
    .filter(
      (action): action is Record<string, unknown> =>
        readString(action?._class)?.endsWith(suffix) ?? false
    )
}

function readTriggeredBy(build: Record<string, unknown> | null): string | null {
  for (const action of findActionByClassSuffix(build, 'CauseAction')) {
    // Jenkins writes the phrase ("Started by user Ada", "Started by timer"), so it is not ours to localize.
    const description = readString(asRecord(readArray(action.causes)[0])?.shortDescription)
    if (description) {
      return description
    }
  }
  return null
}

function isSecretParameter(kind: string | null, name: string): boolean {
  return (kind !== null && SECRET_PARAMETER_KIND_RE.test(kind)) || isSecretParameterName(name)
}

export function readJenkinsParameters(
  build: Record<string, unknown> | null
): PRCheckBuildParameter[] {
  const parameters: PRCheckBuildParameter[] = []
  for (const action of findActionByClassSuffix(build, 'ParametersAction')) {
    for (const raw of readArray(action.parameters)) {
      const parameter = asRecord(raw)
      const name = readString(parameter?.name)
      if (!name) {
        continue
      }
      const secret = isSecretParameter(readString(parameter?._class), name)
      parameters.push({
        name,
        // Why masked here: api/json returns parameter values as stored, and the renderer must never
        // receive a value it is not allowed to show. A secret under an unremarkable name is still
        // shown — the same exposure Jenkins' own API and UI give the same reader.
        value: secret ? '••••' : (readString(parameter?.value) ?? ''),
        secret
      })
      if (parameters.length >= MAX_PARAMETERS) {
        return parameters
      }
    }
  }
  return parameters
}

function readCommits(build: Record<string, unknown> | null): PRCheckBuildCommit[] {
  const commits: PRCheckBuildCommit[] = []
  for (const changeSet of readArray(build?.changeSets).map(asRecord)) {
    for (const raw of readArray(changeSet?.items)) {
      const item = asRecord(raw)
      const id = readString(item?.commitId) ?? readString(item?.id)
      if (!id) {
        continue
      }
      commits.push({
        id,
        message: readString(item?.msg) ?? readString(item?.comment),
        author: readString(asRecord(item?.author)?.fullName)
      })
      if (commits.length >= MAX_COMMITS) {
        return commits
      }
    }
  }
  return commits
}

export function readJenkinsBuildMetadata(
  build: Record<string, unknown> | null,
  workflow: Record<string, unknown> | null
): PRCheckBuild {
  const number = readFiniteNumber(build?.number)
  const estimatedDurationMs = readFiniteNumber(build?.estimatedDuration)
  return {
    number: number === null ? null : String(number),
    queuedMs: readFiniteNumber(workflow?.queueDurationMillis),
    estimatedDurationMs:
      estimatedDurationMs !== null && estimatedDurationMs > 0 ? estimatedDurationMs : null,
    triggeredBy: readTriggeredBy(build),
    parameters: readJenkinsParameters(build),
    commits: readCommits(build)
  }
}
