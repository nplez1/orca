export type MarkdownAction = 'bold' | 'italic' | 'code' | 'quote' | 'list'

export type MarkdownActionResult = {
  value: string
  selectionStart: number
  selectionEnd: number
}

/** Wraps or prefixes the selection with the markdown a composer's formatting
 *  button inserts, returning the next value and the selection to restore.
 *
 *  Shared by every comment composer so the same button does the same thing
 *  wherever it appears — a placeholder stands in when nothing is selected, and
 *  quote/list markers start a line when the caret is not already on one. */
export function applyMarkdownAction(
  value: string,
  start: number,
  end: number,
  action: MarkdownAction
): MarkdownActionResult {
  const selected = value.slice(start, end)
  switch (action) {
    case 'bold':
      return {
        value: `${value.slice(0, start)}**${selected || 'strong text'}**${value.slice(end)}`,
        selectionStart: start + 2,
        selectionEnd: start + 2 + (selected || 'strong text').length
      }
    case 'italic':
      return {
        value: `${value.slice(0, start)}_${selected || 'emphasis'}_${value.slice(end)}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + (selected || 'emphasis').length
      }
    case 'code':
      return {
        value: `${value.slice(0, start)}\`${selected || 'code'}\`${value.slice(end)}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + (selected || 'code').length
      }
    case 'quote': {
      const prefix = start === 0 || value[start - 1] === '\n' ? '> ' : '\n> '
      return {
        value: `${value.slice(0, start)}${prefix}${selected || 'quote'}${value.slice(end)}`,
        selectionStart: start + prefix.length,
        selectionEnd: start + prefix.length + (selected || 'quote').length
      }
    }
    case 'list': {
      const prefix = start === 0 || value[start - 1] === '\n' ? '- ' : '\n- '
      return {
        value: `${value.slice(0, start)}${prefix}${selected || 'item'}${value.slice(end)}`,
        selectionStart: start + prefix.length,
        selectionEnd: start + prefix.length + (selected || 'item').length
      }
    }
  }
}
