import type { LargeDiffRenderLimit } from './large-diff-render-limit'

export type DiffViewerProps = {
  modelKey: string
  originalModelKey?: string
  modifiedModelKey?: string
  originalContent: string
  modifiedContent: string
  language: string
  filePath: string
  relativePath: string
  /** The pre-rename name a provider still files an old review thread under. */
  oldPath?: string
  sideBySide: boolean
  editable?: boolean
  // Hosted review dialogs may have no workspace for local comments.
  worktreeId?: string
  onAddLineComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  commentableLineNumbers?: readonly number[]
  addLineCommentLabel?: string
  addLineCommentPlaceholder?: string
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
  largeDiffRenderLimit?: LargeDiffRenderLimit
  // Render-limited IPC bodies are blank placeholders, never saveable drafts.
  largeDiffSaveContentAvailable?: boolean
  /** False on a historical revision, where review-head line numbers would land on other code. */
  showReviewThreads?: boolean
}
