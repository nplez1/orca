import { JiraApiError, jiraFetch } from './authenticated-request'
import { jiraGatewayBaseUrl } from './gateway-base-url'
import { withJiraRequestDeadline } from './jira-request-deadline'

/** Why the deadline here: `connect` holds one of the four request slots across this
 *  call, and this is the one read that reaches `jiraFetch` without going through
 *  `jiraRequest`. */
export async function resolveJiraGatewayBaseUrl(siteUrl: string): Promise<string> {
  const tenantInfoUrl = new URL('/_edge/tenant_info', siteUrl).toString()
  const data = await withJiraRequestDeadline(undefined, async (signal) => {
    const response = await jiraFetch(tenantInfoUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'Orca' },
      signal
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new JiraApiError(
        `Could not resolve the Atlassian cloud ID at ${new URL(tenantInfoUrl).host}/_edge/tenant_info (HTTP ${response.status}). Check the Jira Cloud site URL.`,
        response.status
      )
    }
    const body: unknown = await response.json()
    return body
  })
  return jiraGatewayBaseUrl(
    data && typeof data === 'object' && 'cloudId' in data ? data.cloudId : undefined
  )
}
