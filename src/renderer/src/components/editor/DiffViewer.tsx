import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache'
import { computeDiffEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { useContextualCopySetup } from './useContextualCopySetup'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { usePRCommentInlineDecorator } from '../pr-comment-inline/usePRCommentInlineDecorator'
import { usePRCommentInlineSurface } from '../pr-comment-inline/usePRCommentInlineSurface'
import { useWorktreePRCommentInline } from '../pr-comment-inline/worktree-pr-comment-inline'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { isDiffComment } from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut, installMonacoEditorFindShortcut } from './editor-shortcuts'
import { diffEditorScrollbarOptions } from './diff-editor-scrollbar-options'
import { LargeDiffFallback } from './LargeDiffFallback'
import { getLargeDiffRenderLimit } from './large-diff-render-limit'
import { useDiffViewerLargeDiffLifecycle } from './useDiffViewerLargeDiffLifecycle'
import { useDiffViewerFirstChangeAutoScroll } from './useDiffViewerFirstChangeAutoScroll'
import { getDiffViewerLargeDiffSaveAction } from './diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import { buildDiffEditorWhitespaceOptions } from './diff-editor-whitespace-options'
import {
  buildDiffEditorWordWrapOptions,
  syncDiffEditorOriginalWordWrap
} from './diff-editor-word-wrap-options'
import { buildDiffEditorHideUnchangedOptions } from './diff-editor-hide-unchanged-options'
import { useDiffEditorRegistration } from './diff-navigation-context'
import { preserveDiffViewStateAcrossModelSwaps } from './diff-model-swap-view-state'
import { monacoFindOptions } from './monaco-find-options'
import { usePluginSyntaxLanguage } from './use-plugin-syntax-language'
import {
  PLUGIN_SYNTAX_EDITOR_OPTIONS,
  applyModelLanguage
} from '@/lib/monaco-languages/plugin-syntax-editor-options'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'

export default function DiffViewer({
  modelKey,
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
  const settings = useAppStore((s) => s.settings)
  const monacoTheme = useMonacoTheme()
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const language = usePluginSyntaxLanguage(filePath, coreLanguage)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const scrollToDiffCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
  // Select the stable worktree array; filter below so unrelated writes do not invalidate this viewer.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isDiffComment(c)),
    [allDiffComments, relativePath]
  )
  const terminalFontSize = settings?.terminalFontSize ?? 13,
    diffEditorFontSize = computeDiffEditorFontSize(terminalFontSize, editorFontZoomLevel)
  const diffWordWrap = settings?.diffWordWrap

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
  const pendingScrollForSurface = useMemo(() => {
    if (pendingScrollForThisViewer) {
      return pendingScrollForThisViewer
    }
    if (!scrollToDiffCommentId || !prCommentSurface?.threads) {
      return null
    }
    return prCommentSurface.threads.some((thread) => thread.id === scrollToDiffCommentId)
      ? scrollToDiffCommentId
      : null
  }, [pendingScrollForThisViewer, prCommentSurface?.threads, scrollToDiffCommentId])

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
      const result = await addDiffComment({
        worktreeId,
        filePath: relativePath,
        source: 'diff',
        startLine,
        lineNumber,
        body,
        side: 'modified'
      })
      if (!result) {
        toast.error(
          translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
        )
      }
      return Boolean(result)
    },
    [addDiffComment, onAddLineComment, relativePath, worktreeId]
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
    canOpenDraft: !renderLimit.limited,
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    onUpdateComment: worktreeId ? (id, body) => updateDiffComment(worktreeId, id, body) : undefined,
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
  onSaveRef.current = onSave
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  const { setupCopy, toastNode } = useContextualCopySetup()

  const propsRef = useRef({ relativePath, language, onSave })
  propsRef.current = { relativePath, language, onSave }
  const currentDiffModelPaths = useDiffViewerLargeDiffLifecycle({
    limited: renderLimit.limited,
    modelKey,
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 relative">
        {renderLimit.limited ? (
          <LargeDiffFallback
            filePath={relativePath}
            renderLimit={renderLimit}
            action={getDiffViewerLargeDiffSaveAction({
              editable,
              modifiedContent,
              onSave,
              saveContentAvailable: largeDiffSaveContentAvailable
            })}
          />
        ) : (
          <DiffEditor
            height="100%"
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
            options={{
              dropIntoEditor: { enabled: false },
              readOnly: !editable,
              originalEditable: false,
              renderSideBySide: sideBySide,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              ...PLUGIN_SYNTAX_EDITOR_OPTIONS,
              fontSize: diffEditorFontSize,
              fontFamily: resolveEditorFontFamily(settings),
              lineNumbers: 'on',
              ...buildDiffEditorWordWrapOptions(settings?.diffWordWrap),
              ...buildDiffEditorWhitespaceOptions(settings?.diffShowWhitespace),
              ...buildDiffEditorHideUnchangedOptions(settings?.diffCollapseUnchangedRegions),
              automaticLayout: true,
              renderOverviewRuler: true,
              scrollbar: diffEditorScrollbarOptions,
              padding: { top: 0 },
              find: monacoFindOptions
            }}
          />
        )}
      </div>
      {toastNode}
    </div>
  )
}
