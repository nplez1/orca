import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Markdown } from '@tiptap/markdown'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { Bold, Code2, Italic, List, LoaderCircle, Quote, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { RichMarkdownToolbarButton } from '@/components/editor/RichMarkdownToolbarButton'
import {
  getRichMarkdownSpellcheckAttribute,
  useRichMarkdownSpellcheckAttribute
} from '@/components/editor/rich-markdown-spellcheck'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export type CommentComposerProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  /** Names the send button for assistive tech and for its tooltip. */
  submitLabel: string
  /** Whether `value` holds something the provider will accept. */
  canSubmit: boolean
  submitting?: boolean
  disabled?: boolean
  disabledReason?: string
  className?: string
}

export type CommentFormatAction = 'bold' | 'italic' | 'code' | 'quote' | 'list'

const FENCE_LINE_PATTERN = /^(?:`{3,}|~{3,})/

/** The serializer's stand-in for an empty paragraph, always a whole line — never
 *  inline, where a `&nbsp;` the user typed is content. Any `>` chain in front is
 *  kept out of the way too: a placeholder line contributes nothing either way. */
const EMPTY_PARAGRAPH_PLACEHOLDER = /^(?:\s*>\s*)*(?:&nbsp;)+\s*$/

/** A list marker with nothing after it: the bullet an editor leaves behind when
 *  the caret is on a new item at submit time. */
const EMPTY_LIST_ITEM = /^[-*+]$/

function isFenceLine(line: string): boolean {
  return FENCE_LINE_PATTERN.test(line.trim())
}

/** Turns the editor's serialized Markdown into what the Jira converter expects.
 *
 *  One Enter = one break: the converter renders one paragraph per source line, so
 *  paragraph breaks are flattened into line breaks, which is what the plain-textarea
 *  composer sent. A real non-breaking space (a common paste from a web page)
 *  becomes a normal space so it cannot fuse two words, and trailing whitespace goes
 *  — the editor writes a hard break as two trailing spaces.
 *
 *  Code fences are left byte-for-byte alone: a pasted snippet's blank lines and
 *  literal `&nbsp;` are its content, not paragraph spacing. */
export function commentMarkdownForSubmit(markdown: string): string {
  const lines: string[] = []
  let inFence = false

  for (const line of markdown.split('\n')) {
    if (isFenceLine(line)) {
      inFence = !inFence
      lines.push(line)
      continue
    }
    if (inFence) {
      lines.push(line)
      continue
    }
    const placeholder = line.match(EMPTY_PARAGRAPH_PLACEHOLDER)
    if (placeholder) {
      continue
    }
    // A blank line, a quote's own blank line, and an empty bullet all contribute
    // no text of their own. Trimming the marker off an empty bullet would leave a
    // bare `-` that the Jira converter reads as literal text.
    if (line.trim().length === 0 || /^>\s*$/.test(line)) {
      continue
    }
    const trimmed = line.replace(/\u00a0/g, ' ').trimEnd()
    if (EMPTY_LIST_ITEM.test(trimmed.trim())) {
      continue
    }
    lines.push(trimmed)
  }

  const body = lines.join('\n')
  return body.length > 0 && markdown.endsWith('\n') ? `${body}\n` : body
}

/** The composer an issue reply is typed into: a bordered bubble whose editing
 *  surface is a live Markdown editor — the formatting controls restyle the
 *  selection in place rather than inserting `**` source — and whose footer row
 *  carries those controls on the left and an icon-only send action on the right.
 *
 *  The provider receives the same Markdown the plain-textarea composer used to
 *  send: the editor's vocabulary is deliberately limited to the constructs Jira's
 *  comment converter can express, so nothing can render here but post as source. */
export function CommentComposer({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  submitLabel,
  canSubmit,
  submitting = false,
  disabled = false,
  disabledReason,
  className
}: CommentComposerProps): React.JSX.Element {
  const spellcheckEnabled = useAppStore((s) => s.settings?.richMarkdownSpellcheckEnabled ?? true)
  const applyingExternalValueRef = useRef(false)
  const lastSyncedMarkdownRef = useRef(value)
  // Why: the editor captures these once, so the handlers read the current prop
  // through a ref instead of a closure that goes stale on the next render.
  const onValueChangeRef = useRef(onValueChange)
  const onSubmitRef = useRef(onSubmit)
  const canSubmitRef = useRef(canSubmit)
  const lockedRef = useRef(false)
  const isMac = navigator.userAgent.includes('Mac')
  const locked = disabled || submitting

  onValueChangeRef.current = onValueChange
  onSubmitRef.current = onSubmit
  canSubmitRef.current = canSubmit
  lockedRef.current = locked

  const extensions = useMemo(
    () => [
      // Why this exact set: it is the vocabulary the Jira comment converter can
      // express (`**bold**`, `*italic*`/`_italic_`, `` `code` ``, fences, quotes,
      // `-` lists). Anything the editor could render but the converter cannot — a
      // heading, a table, a task list, an autolinked URL — would post as literal
      // source, so the two vocabularies must not be able to drift apart.
      StarterKit.configure({
        heading: false,
        strike: false,
        horizontalRule: false,
        orderedList: false,
        link: false
      }),
      Markdown,
      Placeholder.configure({ includeChildren: true, placeholder })
    ],
    [placeholder]
  )

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    editable: !locked,
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'rich-markdown-editor comment-composer-editor',
        spellcheck: getRichMarkdownSpellcheckAttribute(spellcheckEnabled),
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': placeholder
      },
      handleKeyDown: (_view, event) => {
        if (!isScreenSubmitShortcut(event)) {
          return false
        }
        event.preventDefault()
        if (canSubmitRef.current && !lockedRef.current) {
          onSubmitRef.current()
        }
        return true
      }
    },
    onUpdate: ({ editor: updated, transaction }) => {
      // Why the docChanged guard: tiptap also emits `update` for transactions
      // that only changed the selection or the editable flag.
      if (applyingExternalValueRef.current || !transaction.docChanged) {
        return
      }
      const markdown = commentMarkdownForSubmit(updated.getMarkdown())
      lastSyncedMarkdownRef.current = markdown
      onValueChangeRef.current(markdown)
    }
  })
  useRichMarkdownSpellcheckAttribute(editor, spellcheckEnabled)

  useEffect(() => {
    // Why the explicit `false`: setEditable emits an update by default, and on
    // submit the parent clears the draft in the same commit — that stray update
    // would push the just-posted comment straight back into the draft.
    editor?.setEditable(!locked, false)
  }, [editor, locked])

  useEffect(() => {
    if (!editor) {
      return
    }
    // Why: the parent clears to '' after a successful post; the editor has to be
    // reset explicitly or the posted draft would survive in the bubble.
    if (!value.trim()) {
      if (editor.getMarkdown().trim()) {
        applyingExternalValueRef.current = true
        try {
          editor.commands.clearContent(true)
          lastSyncedMarkdownRef.current = ''
        } finally {
          applyingExternalValueRef.current = false
        }
      } else {
        lastSyncedMarkdownRef.current = ''
      }
      return
    }
    if (value === lastSyncedMarkdownRef.current) {
      return
    }
    applyingExternalValueRef.current = true
    try {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      lastSyncedMarkdownRef.current = value
    } finally {
      applyingExternalValueRef.current = false
    }
  }, [editor, value])

  const activeFormats = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      code: current?.isActive('code') ?? false,
      quote: current?.isActive('blockquote') ?? false,
      list: current?.isActive('bulletList') ?? false
    })
  })

  const applyFormat = useCallback(
    (action: CommentFormatAction) => {
      if (!editor) {
        return
      }
      const chain = editor.chain().focus()
      switch (action) {
        case 'bold':
          chain.toggleBold().run()
          break
        case 'italic':
          chain.toggleItalic().run()
          break
        case 'code':
          chain.toggleCode().run()
          break
        case 'quote':
          chain.toggleBlockquote().run()
          break
        case 'list':
          chain.toggleBulletList().run()
          break
      }
    },
    [editor]
  )

  const toolbar: { action: CommentFormatAction; label: string; icon: typeof Bold }[] = [
    {
      action: 'bold',
      label: translate('auto.components.comment.composer.f3e93f1b3a', 'Bold'),
      icon: Bold
    },
    {
      action: 'italic',
      label: translate('auto.components.comment.composer.705066a871', 'Italic'),
      icon: Italic
    },
    {
      action: 'code',
      label: translate('auto.components.comment.composer.20fc7f3d3d', 'Code'),
      icon: Code2
    },
    {
      action: 'quote',
      label: translate('auto.components.comment.composer.96d2a26262', 'Quote'),
      icon: Quote
    },
    {
      action: 'list',
      label: translate('auto.components.comment.composer.564c4d0787', 'List'),
      icon: List
    }
  ]

  return (
    <div
      className={cn(
        // Why the ring lives on the bubble: the editor is borderless inside it, so
        // a focus ring on the field itself would draw a rounded box mid-surface.
        'min-w-0 overflow-hidden rounded-md border border-border bg-background',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        className
      )}
      title={disabled ? disabledReason : undefined}
    >
      <div className="max-h-40 min-h-14 overflow-y-auto scrollbar-sleek">
        <EditorContent editor={editor} />
      </div>
      {/* Why one row: formatting and the send action belong to the same editing
          surface, so the controls sit inside the bubble's own footer rather than
          in a bar below it. */}
      <div className="flex min-w-0 items-center gap-0.5 border-t border-border/60 px-1.5 py-1">
        {toolbar.map(({ action, label, icon: Icon }) => (
          <RichMarkdownToolbarButton
            key={action}
            active={activeFormats?.[action] ?? false}
            pressed={activeFormats?.[action] ?? false}
            label={label}
            compact
            disabled={locked}
            onClick={() => applyFormat(action)}
          >
            <Icon className="size-3" />
          </RichMarkdownToolbarButton>
        ))}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why ghost: the send action is an icon, not a filled control — a
                persistent primary disc reads as a second primary button inside
                the bubble. The hover fill is the affordance. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={submitLabel}
              disabled={locked || !canSubmit}
              onClick={onSubmit}
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disabled && disabledReason ? (
              <span>{disabledReason}</span>
            ) : (
              <span className="flex items-center gap-2">
                <span>{submitLabel}</span>
                <ShortcutKeyCombo
                  keys={[isMac ? '⌘' : 'Ctrl', 'Enter']}
                  className="shrink text-[10px] [&_span]:min-w-0 [&_span]:px-1"
                  separatorClassName="mx-0 text-[10px] text-muted-foreground"
                />
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
