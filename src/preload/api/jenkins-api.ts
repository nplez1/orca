import type { JenkinsBuildDetailsResult } from '../../shared/jenkins-check-details'
import type { JenkinsRebuildResult } from '../../shared/jenkins-rebuild'
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
  /**
   * Rerun the build this check links to, on the configured server that serves it.
   *
   * Takes only the URL. Jenkins replays the build's own script and copies its parameters
   * server-side, so no parameter value — masked or otherwise — crosses this boundary.
   */
  rerunBuild: (args: { url: string }) => Promise<JenkinsRebuildResult>
}
