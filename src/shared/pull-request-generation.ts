import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import type { HostedReviewProvider } from './hosted-review'

export const GENERATED_PULL_REQUEST_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64,
  nestingDepth: 8
} as const

export type PullRequestDraftContext = {
  branch: string | null
  base: string
  branchChangedByPreparation: boolean
  currentTitle: string
  currentBody: string
  currentDraft: boolean
  commitSummary: string
  changeSummary: string
  patch: string
  /** Workspace-linked GitHub issue number. Omitted entirely when none resolves. */
  linkedIssue?: number | null
  provider?: HostedReviewProvider | null
  linkedIssueDetails?: PullRequestLinkedIssue | null
}

export type PullRequestLinkedIssue = {
  provider: Exclude<HostedReviewProvider, 'unsupported'>
  number: number
  title: string
  description: string
}

export type GeneratedPullRequestFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

function stripJsonFence(raw: string): string {
  let text = raw.trim()
  const fencedBody = getJsonFenceBody(text)
  if (fencedBody !== null) {
    text = fencedBody.trim()
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1)
  }
  return text
}

function getJsonFenceBody(text: string): string | null {
  let bodyStart = getLineBreakEnd(text, 3)
  if (bodyStart === null && startsWithAsciiIgnoreCase(text, '```json', 0)) {
    bodyStart = getLineBreakEnd(text, 7)
  }
  if (bodyStart === null || !text.endsWith('```')) {
    return null
  }

  const closeStart = text.length - 3
  const bodyEnd = getBodyEndBeforeClosingFence(text, closeStart)
  return bodyEnd === null ? null : text.slice(bodyStart, bodyEnd)
}

function getLineBreakEnd(text: string, index: number): number | null {
  const code = text.charCodeAt(index)
  if (code === 10) {
    return index + 1
  }
  if (code === 13) {
    return text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1
  }
  return null
}

function getBodyEndBeforeClosingFence(text: string, closeStart: number): number | null {
  const previousCode = text.charCodeAt(closeStart - 1)
  if (previousCode === 10) {
    return text.charCodeAt(closeStart - 2) === 13 ? closeStart - 2 : closeStart - 1
  }
  if (previousCode === 13) {
    return closeStart - 1
  }
  return null
}

function startsWithAsciiIgnoreCase(value: string, search: string, startIndex: number): boolean {
  if (startIndex < 0 || startIndex + search.length > value.length) {
    return false
  }
  for (let index = 0; index < search.length; index++) {
    const code = value.charCodeAt(startIndex + index)
    const normalizedCode = code >= 65 && code <= 90 ? code + 32 : code
    if (normalizedCode !== search.charCodeAt(index)) {
      return false
    }
  }
  return true
}

export function parseGeneratedPullRequestFields(
  raw: string,
  fallback: Pick<PullRequestDraftContext, 'base' | 'currentTitle' | 'currentBody' | 'currentDraft'>
): GeneratedPullRequestFields {
  const content = stripJsonFence(raw)
  assertJsonTextStructureWithinLimits(content, GENERATED_PULL_REQUEST_JSON_STRUCTURE_LIMITS)
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.')
  }
  const record = parsed as Record<string, unknown>
  const base = typeof record.base === 'string' ? record.base.trim() : fallback.base
  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().replace(/[.]+$/g, '')
      : fallback.currentTitle.trim()
  const body =
    typeof record.body === 'string' ? record.body.replace(/\s+$/g, '') : fallback.currentBody
  const draft = typeof record.draft === 'boolean' ? record.draft : fallback.currentDraft

  return {
    base: base || fallback.base,
    title: title || 'Update project files',
    body,
    draft
  }
}
