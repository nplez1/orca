/** Align Skills header, filters and rows on a full-width column instead of wasting wide-window space. */
export const SKILLS_PAGE_COLUMN = 'w-full px-5 md:px-8'

/**
 * Skills owns the top band, so its top row keeps the column's left padding but widens the right one to
 * clear the fixed Windows/Linux window controls. Both forms are explicit: `md:px-8` is emitted after a
 * base `pr-*` and would otherwise undo it on wide windows.
 */
export const SKILLS_PAGE_TOP_ROW_INSET =
  'pr-[max(1.25rem,var(--window-controls-width,0px))] md:pr-[max(2rem,var(--window-controls-width,0px))]'
