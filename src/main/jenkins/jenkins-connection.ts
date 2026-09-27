import { asRecord } from '../../shared/jenkins-payload'
import { normalizeJenkinsBaseUrl } from '../../shared/jenkins-urls'
import type {
  JenkinsSaveServerArgs,
  JenkinsSaveServerResult,
  JenkinsServerProfile,
  JenkinsServerSummary,
  JenkinsServerTestResult
} from '../../shared/jenkins-servers'
import { jenkinsGetJson, type JenkinsRequestFailure } from './jenkins-request'
import {
  createJenkinsServerId,
  hasJenkinsServerToken,
  listJenkinsServers,
  readJenkinsServerToken,
  removeJenkinsServer,
  saveJenkinsServer
} from './jenkins-server-store'

const MAX_LABEL_LENGTH = 60
const MAX_USERNAME_LENGTH = 120
const MAX_TOKEN_LENGTH = 500

function summarize(profile: JenkinsServerProfile): JenkinsServerSummary {
  return { ...profile, hasToken: hasJenkinsServerToken(profile.id) }
}

export function listJenkinsServerSummaries(): JenkinsServerSummary[] {
  return listJenkinsServers().map(summarize)
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function saveJenkinsServerFromArgs(args: JenkinsSaveServerArgs): JenkinsSaveServerResult {
  const baseUrl = normalizeJenkinsBaseUrl(args.baseUrl)
  if (!baseUrl) {
    return { ok: false, error: 'Enter a valid http or https Jenkins URL.' }
  }
  const existing = args.id
    ? listJenkinsServers().find((server) => server.id === args.id)
    : undefined
  // Why: two profiles over one prefix make credential choice arbitrary, so the second is a mistake
  // the user should see rather than a coin flip at request time.
  const duplicate = listJenkinsServers().find(
    (server) => server.baseUrl === baseUrl && server.id !== existing?.id
  )
  if (duplicate) {
    return { ok: false, error: `That URL is already used by "${duplicate.label}".` }
  }

  const username = args.username.trim().slice(0, MAX_USERNAME_LENGTH)
  const apiToken = args.apiToken?.trim().slice(0, MAX_TOKEN_LENGTH) ?? ''
  const profile: JenkinsServerProfile = {
    id: existing?.id ?? createJenkinsServerId(),
    label: args.label.trim().slice(0, MAX_LABEL_LENGTH) || hostLabel(baseUrl),
    baseUrl,
    username
  }
  // Why: an empty token on an edit means "leave the stored one alone"; a server may also be
  // readable anonymously, which is a legitimate configuration.
  saveJenkinsServer(profile, apiToken.length > 0 ? apiToken : null)
  return { ok: true, server: summarize(profile) }
}

export function removeJenkinsServerById(serverId: string): boolean {
  return removeJenkinsServer(serverId)
}

function describeProbeFailure(failure: JenkinsRequestFailure, baseUrl: string): string {
  switch (failure.reason) {
    case 'unauthorized':
      return 'Jenkins rejected those credentials.'
    case 'forbidden':
      return 'Those credentials cannot read this Jenkins.'
    case 'not-found':
      return `No Jenkins API was found at ${baseUrl}.`
    case 'not-jenkins':
      return `${baseUrl} answered, but it does not look like Jenkins.`
    case 'timeout':
      return `${baseUrl} did not respond in time.`
    case 'unreachable':
      return `Could not reach ${baseUrl}: ${failure.message}`
    case 'error':
    case 'not-configured':
      return `Jenkins returned an unexpected response: ${failure.message}`
  }
}

/** A Jenkins root response identifies itself either by header or by its Hudson model class. */
function looksLikeJenkinsRoot(body: unknown, identifiedAsJenkins: boolean): boolean {
  if (identifiedAsJenkins) {
    return true
  }
  const className = asRecord(body)?._class
  return typeof className === 'string' && /hudson\.model\.(Hudson|Jenkins)/i.test(className)
}

/**
 * Read the server's root API to confirm the URL, the credentials and that this is Jenkins at all.
 *
 * Why it probes the root rather than a build: the settings pane only knows what the user typed, so
 * this is the one place a false positive would be persisted as a working server.
 */
export async function probeJenkinsServer(input: {
  baseUrl: string
  username: string
  apiToken: string | null
}): Promise<JenkinsServerTestResult> {
  const baseUrl = normalizeJenkinsBaseUrl(input.baseUrl)
  if (!baseUrl) {
    return { ok: false, error: 'Enter a valid http or https Jenkins URL.' }
  }
  const response = await jenkinsGetJson({
    url: `${baseUrl}/api/json`,
    username: input.username,
    apiToken: input.apiToken
  })
  if (!response.ok) {
    return { ok: false, error: describeProbeFailure(response.failure, baseUrl) }
  }
  if (!looksLikeJenkinsRoot(response.body, response.identifiedAsJenkins)) {
    return { ok: false, error: `${baseUrl} answered, but it does not look like Jenkins.` }
  }
  return { ok: true, version: response.jenkinsVersion }
}

export async function testJenkinsServerById(serverId: string): Promise<JenkinsServerTestResult> {
  const server = listJenkinsServers().find((candidate) => candidate.id === serverId)
  if (!server) {
    return { ok: false, error: 'That Jenkins server is no longer configured.' }
  }
  try {
    return await probeJenkinsServer({
      baseUrl: server.baseUrl,
      username: server.username,
      apiToken: readJenkinsServerToken(server.id)
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
