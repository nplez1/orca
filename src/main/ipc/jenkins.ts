import { ipcMain } from 'electron'
import type { PRCheckDetail } from '../../shared/github/check-types'
import type { JenkinsSaveServerArgs } from '../../shared/jenkins-servers'
import { asRecord } from '../../shared/jenkins-payload'
import { getJenkinsBuildDetails } from '../jenkins/jenkins-build-details'
import {
  listJenkinsServerSummaries,
  removeJenkinsServerById,
  saveJenkinsServerFromArgs,
  testJenkinsServerById
} from '../jenkins/jenkins-connection'

const MAX_URL_LENGTH = 2000
const MAX_NAME_LENGTH = 300

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function normalizeCheckStatus(value: unknown): PRCheckDetail['status'] {
  switch (value) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    default:
      return 'queued'
  }
}

function normalizeCheckConclusion(value: unknown): PRCheckDetail['conclusion'] {
  switch (value) {
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'timed_out':
    case 'neutral':
    case 'skipped':
    case 'pending':
    case 'action_required':
      return value
    default:
      return null
  }
}

/** Registers every `jenkins:*` IPC handler on the main process. */
export function registerJenkinsHandlers(): void {
  ipcMain.handle('jenkins:listServers', () => listJenkinsServerSummaries())

  ipcMain.handle('jenkins:saveServer', (_event, args: unknown) => {
    const input = asRecord(args)
    if (!input) {
      return { ok: false, error: 'Invalid Jenkins server.' }
    }
    const id = readString(input.id, MAX_NAME_LENGTH)
    const saveArgs: JenkinsSaveServerArgs = {
      ...(id ? { id } : {}),
      label: readString(input.label, 60),
      baseUrl: readString(input.baseUrl, MAX_URL_LENGTH),
      username: readString(input.username, 120),
      apiToken: readString(input.apiToken, 500)
    }
    return saveJenkinsServerFromArgs(saveArgs)
  })

  ipcMain.handle('jenkins:removeServer', (_event, args: unknown) => {
    const id = readString(asRecord(args)?.id, MAX_NAME_LENGTH)
    return { ok: id.length > 0 && removeJenkinsServerById(id) }
  })

  ipcMain.handle('jenkins:testServer', (_event, args: unknown) => {
    const id = readString(asRecord(args)?.id, MAX_NAME_LENGTH)
    if (id.length === 0) {
      return { ok: false, error: 'Invalid Jenkins server.' }
    }
    return testJenkinsServerById(id)
  })

  ipcMain.handle('jenkins:buildDetails', (_event, args: unknown) => {
    const input = asRecord(args)
    const url = readString(input?.url, MAX_URL_LENGTH)
    if (url.length === 0) {
      return { ok: false, reason: 'not-jenkins', serverUrl: null, message: null }
    }
    return getJenkinsBuildDetails({
      url,
      check: {
        name: readString(input?.checkName, MAX_NAME_LENGTH) || 'Check',
        status: normalizeCheckStatus(input?.status),
        conclusion: normalizeCheckConclusion(input?.conclusion),
        url
      }
    })
  })
}
