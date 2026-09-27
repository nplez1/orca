import type { JenkinsBuildDetailsResult } from '../../shared/jenkins-check-details'
import type {
  JenkinsSaveServerResult,
  JenkinsServerSummary,
  JenkinsServerTestResult
} from '../../shared/jenkins-servers'

export type JenkinsApi = {
  listServers: () => Promise<JenkinsServerSummary[]>
  saveServer: (args: {
    id?: string
    label: string
    baseUrl: string
    username: string
    apiToken?: string
  }) => Promise<JenkinsSaveServerResult>
  removeServer: (args: { id: string }) => Promise<{ ok: boolean }>
  testServer: (args: { id: string }) => Promise<JenkinsServerTestResult>
  /** Build details for a check whose URL points at Jenkins, or a classified reason it has none. */
  buildDetails: (args: {
    url: string
    checkName: string
    status: string
    conclusion: string | null
  }) => Promise<JenkinsBuildDetailsResult>
}
