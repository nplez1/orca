/**
 * Upstream split the Jira error class into this module. The fork's request layer in
 * `authenticated-request.ts` throws one class that also carries Jira's per-field
 * rejections, so this module re-exports that single class instead of declaring a
 * second one: two `JiraApiError` classes would make every `instanceof` check depend on
 * which module an error happened to come from.
 */
export { JiraApiError } from './authenticated-request'
