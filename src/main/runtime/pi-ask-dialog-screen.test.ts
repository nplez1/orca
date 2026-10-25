import { describe, expect, it } from 'vitest'
import { PiAskDialogScreenGained, showsPiAskDialogScreen } from './pi-ask-dialog-screen'

/** Rows below are lifted from a real capture: Pi-Bolt 1.0.0 `ask_user_question`, 100x30 PTY, read
 *  through the emulator's grid — the only place pi's card exists. */
const CARD_FOOTER =
  ' Enter to select · ↑/↓ to navigate · Esc to cancel · Ctrl+] to collapse · Shift+Enter for newline · Ctrl+U to clear'

const CARD_GRID = [
  ' Ask Colour',
  '───────────────────────────────────────────────────────────────────────────────',
  '  Colour',
  ' Which colour do you prefer most?',
  '  1. Blue',
  '     Cool, calm, and the most commonly cited favourite.',
  '❯ 4.',
  '───────────────────────────────────────────────────────────────────────────────',
  CARD_FOOTER
]

describe('pi ask-card screen', () => {
  it('reads a question card from the rendered grid', () => {
    expect(showsPiAskDialogScreen(CARD_GRID)).toBe(true)
  })

  it('counts a multi-select card, whose footer offers toggling instead of selecting', () => {
    expect(showsPiAskDialogScreen([' Space to toggle · Enter to confirm · Esc to cancel'])).toBe(
      true
    )
  })

  it('is not a card when only one half of the footer is on screen', () => {
    // Why: pi's transcript quotes its own footer when it narrates about a card, and one half alone
    // is also a composer hint. The pair on one line is what only the card paints.
    expect(showsPiAskDialogScreen([' I will add the Enter to select hint.'])).toBe(false)
    expect(showsPiAskDialogScreen([' Esc to cancel.'])).toBe(false)
  })

  it('is not a card on a working transcript', () => {
    expect(showsPiAskDialogScreen([' $ pnpm test', ' ✓ 42 tests passed'])).toBe(false)
  })
})

describe('pi ask-card gained stamp', () => {
  it('keeps the first sighting while the card stays on screen', () => {
    const gained = new PiAskDialogScreenGained()
    expect(gained.observe('pty-1', CARD_GRID, 1_000)).toEqual({
      reason: 'agent-interactive-prompt',
      since: 1_000
    })
    // Why: a later read must not restate the wait as new — the stamp is what proves the card
    // predates a row that claims the pane is working.
    expect(gained.observe('pty-1', CARD_GRID, 9_000)?.since).toBe(1_000)
  })

  it('forgets the card once the grid no longer holds it', () => {
    const gained = new PiAskDialogScreenGained()
    gained.observe('pty-1', CARD_GRID, 1_000)
    expect(gained.observe('pty-1', [' done, 42 tests passed'], 5_000)).toBeNull()
    expect(gained.observe('pty-1', CARD_GRID, 7_000)?.since).toBe(7_000)
  })

  it('answers unreadable for a grid it does not have, which is not an empty one', () => {
    const gained = new PiAskDialogScreenGained()
    expect(gained.observe('pty-1', null, 1_000)).toBeUndefined()
  })

  it('keeps one clock per pane', () => {
    const gained = new PiAskDialogScreenGained()
    gained.observe('pty-1', CARD_GRID, 1_000)
    expect(gained.observe('pty-2', CARD_GRID, 4_000)?.since).toBe(4_000)
    expect(gained.observe('pty-1', CARD_GRID, 6_000)?.since).toBe(1_000)
  })

  it('drops a pane it is told to forget, so its next card starts a new clock', () => {
    // Why: the pane's own title can withdraw the claim while the grid still shows a footer-shaped
    // line, and the next real card must not inherit a stamp from that.
    const gained = new PiAskDialogScreenGained()
    gained.observe('pty-1', CARD_GRID, 1_000)
    gained.forget('pty-1')
    expect(gained.observe('pty-1', CARD_GRID, 8_000)?.since).toBe(8_000)
  })
})
