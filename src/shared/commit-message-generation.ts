import { cleanGeneratedCommitMessage } from './commit-message-prompt'
import type { TuiAgent } from './tui-agent'

export type CommitMessageDraftAgent = TuiAgent | 'custom'

export type CommitMessageDraftContext = {
  branch: string | null
  stagedSummary: string
  stagedPatch: string
  /** Workspace-linked GitHub issue number. Omitted entirely when none resolves. */
  linkedIssue?: number | null
}

export type GeneratedCommitMessage = {
  subject: string
  body: string
  message: string
}

export function splitGeneratedCommitMessage(message: string): GeneratedCommitMessage {
  const normalized = cleanGeneratedCommitMessage(message)
  const firstNewline = normalized.indexOf('\n')
  const subjectLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline)
  const subject = subjectLine.trim().replace(/[.]+$/g, '').slice(0, 72).trimEnd()
  const body = firstNewline === -1 ? '' : normalized.slice(firstNewline + 1).trim()
  const safeSubject = subject.length > 0 ? subject : 'Update project files'
  return {
    subject: safeSubject,
    body,
    message: body.length > 0 ? `${safeSubject}\n\n${body}` : safeSubject
  }
}
