import { z } from 'zod'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export const VALID_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

export const SiteSelection = z
  .object({
    siteId: OptionalString
  })
  .optional()

// Why: a site can expose thousands of boards, so the settings picker filters them
// by name server-side instead of paging the whole list. `name` is additive: older
// clients that send only siteId keep the unfiltered first page.
export const BoardListQuery = z
  .object({
    siteId: OptionalString,
    name: OptionalString
  })
  .optional()

export const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  // Self-hosted PAT auth needs no email; connect() enforces it for Cloud.
  email: OptionalPlainString,
  apiToken: requiredString('API token is required'),
  authType: z.enum(['cloud', 'server']).optional()
})

export const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

export const SearchIssues = z.object({
  jql: requiredString('Missing JQL'),
  limit: OptionalFiniteNumber,
  siteId: OptionalString
})

export const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString
  })
  .optional()

export const IssueKey = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString
})

export const CreateIssue = z.object({
  siteId: OptionalString,
  projectId: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  title: requiredString('Title is required'),
  description: OptionalPlainString,
  customFields: z.record(z.string(), z.unknown()).optional(),
  userFieldKeys: z.array(z.string()).optional(),
  textFieldKeys: z.array(z.string()).optional()
})

// Why: the field-edit path targets custom fields; system fields have dedicated
// update fields, and the transition screen is the one place a workflow names
// them. Matches the local IPC narrowing so both hosts refuse the same payloads.
const CustomFieldUpdateMap = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).every((key) => key.startsWith('customfield_')), {
    message: 'Custom-field updates may only name custom fields'
  })

export const IssueUpdate = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  updates: z.object({
    title: OptionalString,
    labels: z.array(z.string()).optional(),
    assigneeAccountId: z.union([z.string(), z.null()]).optional(),
    priorityId: z.union([z.string(), z.null()]).optional(),
    transitionId: OptionalString,
    // Why these stay declared: the zod object strips keys it does not name, and
    // the dispatcher hands the stripped object to the handler, so an undeclared
    // field would reach the host as a silent no-op on every remote runtime.
    transitionFields: z.record(z.string(), z.unknown()).optional(),
    transitionUserFieldKeys: z.array(z.string()).optional(),
    transitionTextFieldKeys: z.array(z.string()).optional(),
    customFields: CustomFieldUpdateMap.optional(),
    userFieldKeys: z.array(z.string()).optional(),
    textFieldKeys: z.array(z.string()).optional()
  })
})

export const IssueComment = z.object({
  key: requiredString('Issue key is required'),
  body: requiredString('Comment body is required'),
  siteId: OptionalString,
  // Why optional: a client that omits it (an older one, or the CLI) sends text the
  // host stores verbatim, which is what every pre-composer caller already did.
  bodyFormat: z.enum(['plain', 'markdown']).optional()
})

export const ProjectIssueTypes = z.object({
  projectIdOrKey: requiredString('Project is required'),
  siteId: OptionalString
})

export const ProjectIssueTypeFields = z.object({
  projectIdOrKey: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  siteId: OptionalString
})

export const AssignableUsers = z.object({
  key: requiredString('Issue key is required'),
  query: OptionalPlainString,
  siteId: OptionalString
})

export const UserSearch = z.object({
  query: OptionalPlainString,
  siteId: OptionalString
})

export const ProjectStatusOrder = z.object({
  projectKey: requiredString('Project key is required'),
  siteId: OptionalString
})

export const BoardIdentifier = z.object({
  boardId: requiredString('Board ID is required'),
  siteId: requiredString('Site ID is required')
})

const BoardIssuePageFields = {
  boardId: requiredString('Board ID is required'),
  siteId: requiredString('Site ID is required'),
  pageToken: OptionalString,
  startAt: OptionalFiniteNumber,
  maxResults: OptionalFiniteNumber
}

export const BoardIssuePage = z.discriminatedUnion('scope', [
  z.object({ ...BoardIssuePageFields, scope: z.literal('backlog') }),
  z.object({
    ...BoardIssuePageFields,
    scope: z.literal('sprint'),
    sprintId: requiredString('Sprint ID is required')
  })
])
