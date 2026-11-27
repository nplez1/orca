export class JiraApiError extends Error {
  status: number | null
  /** Jira's per-field rejections, keyed by field key: an `errors` object from a refused field. */
  fieldErrors?: Record<string, string>
  /** Jira's non-field error strings, e.g. a workflow rule that failed outright. */
  errorMessages?: string[]
  /** True when the token's scopes do not cover this request: valid but under-scoped, so keep it. */
  scopeMismatch = false

  constructor(
    message: string,
    status: number | null = null,
    detail?:
      | {
          fieldErrors?: Record<string, string>
          errorMessages?: string[]
          scopeMismatch?: boolean
        }
      // Upstream's call sites pass the scope flag positionally rather than as detail.
      | boolean
  ) {
    super(message)
    this.status = status
    const fields = typeof detail === 'boolean' ? undefined : detail
    this.fieldErrors = fields?.fieldErrors
    this.errorMessages = fields?.errorMessages
    this.scopeMismatch = typeof detail === 'boolean' ? detail : fields?.scopeMismatch === true
  }
}
