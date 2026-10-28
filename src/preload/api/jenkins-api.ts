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
   * Start the build this check links to again, on the configured server that serves it.
   *
   * Takes only the URL: the build number, its parameters and whether it can be replayed are all
   * read from Jenkins in the main process, so a masked secret never travels back out again.
   */
  rebuild: (args: { url: string }) => Promise<JenkinsRebuildResult>
}
