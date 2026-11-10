/* eslint-disable max-lines -- Why: upstream-owned and at its budget; the fork's 31-code-line delta rides inside it, and splitting costs a permanent sync hunk. */
import { NO_RESOURCE_EVIDENCE } from '@/lib/workspace/ownership/workspace-copy-owner'
import { useDiffCommentView } from '../../../diff-comments/use-diff-comment-owner'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store/index'
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache'
import { monacoTypographyOptions } from '@/lib/editor/appearance/editor-typography'
import { useEditorTypography } from '@/hooks/use-editor-typography'
import { useContextualCopySetup } from '../../useContextualCopySetup'
import { useDiffCommentDecorator } from '../../../diff-comments/useDiffCommentDecorator'
import { usePRCommentInlineDecorator } from '../../../pr-comment-inline/usePRCommentInlineDecorator'
import { usePRCommentInlineSurface } from '../../../pr-comment-inline/usePRCommentInlineSurface'
import { useWorktreePRCommentInline } from '../../../pr-comment-inline/worktree-pr-comment-inline'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import { isDiffComment } from '@/lib/source-control/review/comments/diff-comment-compat'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from '../../editor-shortcuts'
import { diffEditorScrollbarOptions } from './diff-editor-scrollbar-options'
import { LargeDiffFallback } from '../large-files/LargeDiffFallback'
import { getLargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'
import { useDiffViewerLargeDiffLifecycle } from '../large-files/useDiffViewerLargeDiffLifecycle'
import { useDiffViewerFirstChangeAutoScroll } from './useDiffViewerFirstChangeAutoScroll'
import { getDiffViewerLargeDiffSaveAction } from '../large-files/diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import { buildDiffEditorWhitespaceOptions } from './diff-editor-whitespace-options'
import {
  buildDiffEditorWordWrapOptions,
  syncDiffEditorOriginalWordWrap
} from './diff-editor-word-wrap-options'
import { buildDiffEditorHideUnchangedOptions } from './diff-editor-hide-unchanged-options'
import { useDiffEditorRegistration } from '../review/diff-navigation-context'
import { preserveDiffViewStateAcrossModelSwaps } from './diff-model-swap-view-state'
import { monacoFindOptions } from '../../monaco-find-options'
import { buildEditorUnicodeHighlightOptions } from '../../editor-unicode-highlight-options'
import { usePluginSyntaxLanguage } from '../../use-plugin-syntax-language'
import {
  PLUGIN_SYNTAX_EDITOR_OPTIONS,
  applyModelLanguage
} from '@/lib/monaco-languages/plugin-syntax-editor-options'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'
import { cn } from '@/lib/utils'
import { wholeFileDiffTintClass } from './whole-file-diff-tint'

export default function DiffViewer({
  modelKey,
  modelOwnerKey,
  originalModelKey,
  modifiedModelKey,
  originalContent,
  modifiedContent,
  language: coreLanguage,
  filePath,
  relativePath,
  oldPath,
  sideBySide,
  editable,
  worktreeId,
  noteSource = NO_RESOURCE_EVIDENCE,
  onAddLineComment,
  commentableLineNumbers,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  onContentChange,
  onSave,
  largeDiffRenderLimit,
  largeDiffSaveContentAvailable,
  showReviewThreads = true
}: DiffViewerProps): React.JSX.Element {
  const t = useTranslate()
  const diffWordWrap = useAppStore((s) => s.settings?.diffWordWrap)
  const diffShowWhitespace = useAppStore((s) => s.settings?.diffShowWhitespace)
  const diffCollapseUnchangedRegions = useAppStore((s) => s.settings?.diffCollapseUnchangedRegions)
  const monacoTheme = useMonacoTheme()
  const diffTypography = useEditorTypography('diff')
  // One read: the stable notes array and the copy it belongs to; filter below so unrelated writes don't invalidate.
  const { owner: commentOwner, comments: allDiffComments } = useDiffCommentView(
    worktreeId,
    noteSource
  )
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const language = usePluginSyntaxLanguage(filePath, coreLanguage)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isDiffComment(c)),
    [allDiffComments, relativePath]
  )

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const { registerDiffEditor, unregisterDiffEditor } = useDiffEditorRegistration()
  const lineNumberOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const wordWrapOptionsSubRef = useRef<{ dispose: () => void } | null>(null)
  const wordWrapMountFrameRef = useRef(0)
  const diffWordWrapRef = useRef(diffWordWrap)
  useLayoutEffect(() => {
    diffWordWrapRef.current = diffWordWrap
  }, [diffWordWrap])
  const [modifiedEditor, setModifiedEditor] = useState<editor.ICodeEditor | null>(null)
  useEffect(() => {
    const models = diffEditorRef.current?.getModel()
    applyModelLanguage([models?.original, models?.modified], language)
  }, [modifiedEditor, language])

  const renderLimit = useMemo(
    () => largeDiffRenderLimit ?? getLargeDiffRenderLimit({ originalContent, modifiedContent }),
    [largeDiffRenderLimit, originalContent, modifiedContent]
  )
  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  // Why: the worktree diff shows the same file the PR reviews, so it draws the same review threads —
  // through its own decorator instance so the local-note add-note flow is untouched.
  const worktreePRComments = useWorktreePRCommentInline(showReviewThreads ? worktreeId : null)
  const prCommentSurface = usePRCommentInlineSurface(worktreePRComments, relativePath, oldPath)

  // Why: only forward the pending scroll id when this viewer owns the comment, else unrelated viewers race to ack it.
  const pendingScrollForThisViewer = useMemo(() => {
    if (!worktreeId || !scrollToDiffCommentId) {
      return null
    }
    return diffComments.some((c) => c.id === scrollToDiffCommentId) ? scrollToDiffCommentId : null
  }, [scrollToDiffCommentId, diffComments, worktreeId])

  // Why: a review thread reveal owns the scroll the same way a local note does — otherwise the
  // first-change auto-scroll below undoes it in a diff tab that has no stored view state yet.
  const prCommentThreads = prCommentSurface?.threads
  const pendingScrollForSurface = useMemo(() => {
    if (pendingScrollForThisViewer) {
      return pendingScrollForThisViewer
    }
    if (!scrollToDiffCommentId || !prCommentThreads) {
      return null
    }
    return prCommentThreads.some((thread) => thread.id === scrollToDiffCommentId)
      ? scrollToDiffCommentId
      : null
  }, [pendingScrollForThisViewer, prCommentThreads, scrollToDiffCommentId])

  // A draft keeps its captured owner across a same-tab rename but saves under the file's current path.
  const relativePathRef = useRef(relativePath)
  useLayoutEffect(() => {
    relativePathRef.current = relativePath
  }, [relativePath])
  const handleCreateComment = useCallback(
    async ({
      lineNumber,
      startLine,
      body
    }: {
      lineNumber: number
      startLine?: number
      body: string
    }): Promise<boolean> => {
      if (onAddLineComment) {
        return onAddLineComment({
          lineNumber,
          startLine,
          body
        })
      }
      if (!worktreeId) {
        return false
      }
      const result = await (commentOwner
        ? addDiffComment(commentOwner, {
            worktreeId,
            filePath: relativePathRef.current,
            source: 'diff',
            startLine,
            lineNumber,
            body,
            side: 'modified'
          })
        : null)
      if (!result) {
        toast.error(
          translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
        )
      }
      return Boolean(result)
    },
    [commentOwner, addDiffComment, onAddLineComment, worktreeId]
  )

  // Why: the worktree diff shows the same file the PR reviews, so it draws the same review threads —
  // through its own decorator instance so the local-note add-note flow is untouched, and ahead of the
  // local-note decorator so the lines a collapsed thread marks are lines the "+" skips. Also ahead of
  // the first-change auto-scroll below, which defers to a thread reveal.
  const prCommentGutter = usePRCommentInlineDecorator({
    editor: modifiedEditor,
    monacoModelIdentity: modifiedModelKey ?? modelKey,
    filePath: relativePath,
    threads: prCommentSurface?.threads ?? null,
    scope: prCommentSurface?.scope ?? null,
    enabled: prCommentSurface?.enabled ?? false,
    onReply: prCommentSurface?.onReply,
    onResolveThread: prCommentSurface?.onResolveThread,
    pendingRevealCommentId: prCommentSurface?.pendingRevealCommentId ?? null,
    onPendingRevealConsumed: prCommentSurface?.onPendingRevealConsumed
  })

  // Why: gate the decorator on a comment target; updateDiffComment is only wired for local diffs (worktreeId present).
  useDiffCommentDecorator({
    captureCreateComment: !onAddLineComment,
    commentOwner,
    editor: hasLineCommentAction ? modifiedEditor : null,
    monacoModelIdentity: modifiedModelKey ?? modelKey,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: worktreeId ? diffComments : [],
    commentableLineNumbers,
    gutterOccupiedLineNumbers: prCommentGutter.gutterOccupiedLines,
    addButtonLabel: addLineCommentLabel,
    addNoteShortcutEnabled: hasLineCommentAction,
    onCreateComment: handleCreateComment,
    draftPlaceholder: addLineCommentPlaceholder,
    draftSubmitLabel: addLineCommentLabel,
    // Notes of an unknown copy can't be added to; hosted review comments have no local copy.
    canOpenDraft: !renderLimit.limited && (commentOwner !== null || Boolean(onAddLineComment)),
    onDeleteComment: (id) => {
      if (worktreeId) {
        void (commentOwner && deleteDiffComment(commentOwner, id))
      }
    },
    onUpdateComment: worktreeId
      ? (id, body) =>
          commentOwner ? updateDiffComment(commentOwner, id, body) : Promise.resolve(false)
      : undefined,
    pendingScrollCommentId: pendingScrollForThisViewer,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })

  useDiffViewerFirstChangeAutoScroll({
    diffEditorRef,
    modifiedEditor,
    modelKey,
    pendingScrollCommentId: pendingScrollForSurface
  })

  const handleEnterLargeDiffFallback = useCallback(() => {
    // Fallback disposes Monaco; clear refs before decorators or save handlers can use them.
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = null
    cancelAnimationFrame(wordWrapMountFrameRef.current)
    wordWrapOptionsSubRef.current?.dispose()
    wordWrapOptionsSubRef.current = null
    // Capture the exact instance before clearing; unregister ignores stale identities.
    const fallenBackEditor = diffEditorRef.current
    diffEditorRef.current = null
    if (fallenBackEditor) {
      unregisterDiffEditor(fallenBackEditor)
    }
    setModifiedEditor(null)
  }, [unregisterDiffEditor])

  const onSaveRef = useRef(onSave)
  const onContentChangeRef = useRef(onContentChange)
  const propsRef = useRef({ relativePath, language, onSave })
  useLayoutEffect(() => {
    onSaveRef.current = onSave
    onContentChangeRef.current = onContentChange
    propsRef.current = { relativePath, language, onSave }
  }, [language, onSave, onContentChange, relativePath])

  const { setupCopy, toastNode } = useContextualCopySetup()
  const currentDiffModelPaths = useDiffViewerLargeDiffLifecycle({
    limited: renderLimit.limited,
    modelKey,
    modelOwnerKey,
    originalModelKey,
    modifiedModelKey,
    diffEditorRef,
    onEnterFallback: handleEnterLargeDiffFallback
  })

  const handleMount: DiffOnMount = useCallback(
    (diffEditor, monaco) => {
      diffEditorRef.current = diffEditor
      registerDiffEditor(diffEditor)
      // Monaco applies its inline wrap override after mount when width is known.
      wordWrapMountFrameRef.current = requestAnimationFrame(() => {
        if (diffEditorRef.current !== diffEditor) {
          return
        }
        wordWrapOptionsSubRef.current?.dispose()
        wordWrapOptionsSubRef.current = syncDiffEditorOriginalWordWrap(
          diffEditor,
          diffWordWrapRef.current
        )
      })
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)

      const originalEditor = diffEditor.getOriginalEditor()
      const modifiedEditor = diffEditor.getModifiedEditor()
      modifiedEditor.onDidDispose(() => {
        if (diffEditorRef.current !== diffEditor) {
          return
        }
        cancelAnimationFrame(wordWrapMountFrameRef.current)
        lineNumberOptionsSubRef.current?.dispose()
        lineNumberOptionsSubRef.current = null
        wordWrapOptionsSubRef.current?.dispose()
        wordWrapOptionsSubRef.current = null
        unregisterDiffEditor(diffEditor)
        diffEditorRef.current = null
        setModifiedEditor(null)
      })
      diffEditor.onDidDispose(preserveDiffViewStateAcrossModelSwaps(diffEditor).dispose)

      setupCopy(originalEditor, monaco, filePath, propsRef)
      setupCopy(modifiedEditor, monaco, filePath, propsRef)
      setModifiedEditor(modifiedEditor)

      // Restore cursor and selection across both panes alongside scroll.
      const savedViewState = diffViewStateCache.get(modelKey)
      if (savedViewState) {
        requestAnimationFrame(() => diffEditor.restoreViewState(savedViewState))
      }
      // Auto-scroll runs separately after decorator view zones mount.

      if (editable) {
        const cleanupSaveShortcut = installEditorSaveShortcut(
          modifiedEditor.getContainerDomNode(),
          () => {
            onSaveRef.current?.(modifiedEditor.getValue())
          }
        )
        const cleanupOriginalFindShortcut = installMonacoEditorFindShortcut(originalEditor)
        const cleanupModifiedFindShortcut = installMonacoEditorFindShortcut(modifiedEditor)

        const modelContentSub = modifiedEditor.onDidChangeModelContent(() => {
          onContentChangeRef.current?.(modifiedEditor.getValue())
        })
        modifiedEditor.onDidDispose(() => {
          // Shortcut bridges and model subscriptions belong to this diff instance.
          cleanupSaveShortcut()
          cleanupOriginalFindShortcut()
          cleanupModifiedFindShortcut()
          modelContentSub.dispose()
        })

        modifiedEditor.focus()
      } else {
        diffEditor.focus()
      }
    },
    [editable, setupCopy, modelKey, filePath, sideBySide, registerDiffEditor, unregisterDiffEditor]
  )

  // Snapshot on layout cleanup before unmount, avoiding scroll-time writes.
  useLayoutEffect(() => {
    return () => {
      const de = diffEditorRef.current
      if (de) {
        const currentViewState = de.saveViewState()
        if (currentViewState) {
          setWithLRU(diffViewStateCache, modelKey, currentViewState)
        }
      }
    }
  }, [modelKey])

  useEffect(() => {
    cancelAnimationFrame(wordWrapMountFrameRef.current)
    const diffEditor = diffEditorRef.current
    if (!diffEditor) {
      return () => {
        cancelAnimationFrame(wordWrapMountFrameRef.current)
      }
    }
    lineNumberOptionsSubRef.current?.dispose()
    lineNumberOptionsSubRef.current = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)
    wordWrapOptionsSubRef.current?.dispose()
    wordWrapOptionsSubRef.current = syncDiffEditorOriginalWordWrap(diffEditor, diffWordWrap)
    return () => {
      cancelAnimationFrame(wordWrapMountFrameRef.current)
      lineNumberOptionsSubRef.current?.dispose()
      lineNumberOptionsSubRef.current = null
      wordWrapOptionsSubRef.current?.dispose()
      wordWrapOptionsSubRef.current = null
    }
  }, [diffWordWrap, sideBySide])

  // Why: @monaco-editor/react calls updateOptions whenever this object's identity changes.
  const editorOptions = useMemo<editor.IDiffEditorConstructionOptions>(
    () => ({
      dropIntoEditor: { enabled: false },
      readOnly: !editable,
      originalEditable: false,
      renderSideBySide: sideBySide,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ...PLUGIN_SYNTAX_EDITOR_OPTIONS,
      ...monacoTypographyOptions(diffTypography),
      lineNumbers: 'on',
      ...buildDiffEditorWordWrapOptions(diffWordWrap),
      ...buildDiffEditorWhitespaceOptions(diffShowWhitespace),
      ...buildDiffEditorHideUnchangedOptions(diffCollapseUnchangedRegions),
      automaticLayout: true,
      renderOverviewRuler: true,
      scrollbar: diffEditorScrollbarOptions,
      padding: { top: 0 },
      find: monacoFindOptions,
      unicodeHighlight: buildEditorUnicodeHighlightOptions(language)
    }),
    [
      language,
      editable,
      sideBySide,
      diffTypography,
      diffWordWrap,
      diffShowWhitespace,
      diffCollapseUnchangedRegions
    ]
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 relative">
        {renderLimit.limited ? (
          <LargeDiffFallback
            filePath={relativePath}
            renderLimit={renderLimit}
            action={getDiffViewerLargeDiffSaveAction(
              {
                editable,
                modifiedContent,
                onSave,
                saveContentAvailable: largeDiffSaveContentAvailable
              },
              t
            )}
          />
        ) : (
          <DiffEditor
            height="100%"
            // Why: the overview ruler column is unpainted; it shows this surface, not the app's.
            className={cn(
              'code-editor-backdrop',
              wholeFileDiffTintClass(originalContent, modifiedContent)
            )}
            language={language}
            original={originalContent}
            modified={modifiedContent}
            theme={monacoTheme}
            onMount={handleMount}
            // Tab-owned models preserve modified undo across Changes-mode HEAD rotations.
            originalModelPath={currentDiffModelPaths.originalModelPath}
            modifiedModelPath={currentDiffModelPaths.modifiedModelPath}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={editorOptions}
          />
        )}
      </div>
      {toastNode}
    </div>
  )
}
