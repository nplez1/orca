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

/** The footers pi paints outside `ask_user_question`: the collapsed card, a footer clipped by pane
 *  width, and pi-tui's own selector, which a permission gate, a plan review and the project-trust
 *  prompt use. None of them matched an anchor, so the lane read "no card" while a dialog held the
 *  pane (#227). */
const OTHER_PI_CARD_FOOTERS = [
  ' Ctrl+] to expand · Esc to cancel',
  ' Enter to select · ↑/↓ to navigate · …',
  ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
  ' ↑↓ navigate  enter submit  escape/ctrl+c cancel',
  ' enter submit  shift+enter/ctrl+j newline  escape/ctrl+c cancel  ctrl+g external editor'
]

describe("pi's other dialog footers", () => {
  it.each(OTHER_PI_CARD_FOOTERS)('reads %j as a card', (footer) => {
    expect(showsPiAskDialogScreen([footer])).toBe(true)
  })

  it.each([
    // Half a footer is a composer hint or a transcript quote, never the pair only a card paints.
    ' ↑↓ navigate  enter select',
    // The expand affordance alone names the card's state, not that a card holds the pane.
    ' Ctrl+] to expand',
    ' enter submit  shift+enter newline'
  ])('still reads %j as no card', (line) => {
    expect(showsPiAskDialogScreen([line])).toBe(false)
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

  it('keeps the stamp when the grid stops showing the card, because the marker owns the clear', () => {
    // Why: the marker is the authority on whether a dialog is still open. Clearing on an absent
    // footer would reset `since` on every read of a card this reader cannot recognise - the very
    // case the claim answers - turning the stamp into "the last time we looked".
    const gained = new PiAskDialogScreenGained()
    gained.observe('pty-1', CARD_GRID, 1_000)
    expect(gained.observe('pty-1', [' done, 42 tests passed'], 5_000)).toBeNull()
    expect(gained.observe('pty-1', CARD_GRID, 7_000)?.since).toBe(1_000)
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

describe("the pane's own dialog claim", () => {
  it('answers a wait for a card the grid cannot be read for', () => {
    // Why: `π !` is pi's own claim, painted for exactly as long as a dialog holds the pane. The
    // footer vocabulary is a proxy measured one card build at a time, and every wording it did not
    // know left a displaced row on Working - the bug this answers for.
    const gained = new PiAskDialogScreenGained()
    expect(gained.observeClaim('pty-1', 1_000)).toEqual({
      reason: 'agent-interactive-prompt',
      since: 1_000
    })
  })

  it('keeps the first sighting of the claim across later reads', () => {
    const gained = new PiAskDialogScreenGained()
    gained.observeClaim('pty-1', 1_000)
    expect(gained.observeClaim('pty-1', 9_000).since).toBe(1_000)
  })

  it('shares one clock with the grid, so a card read either way is dated once', () => {
    const gained = new PiAskDialogScreenGained()
    expect(gained.observe('pty-1', CARD_GRID, 1_000)?.since).toBe(1_000)
    expect(gained.observeClaim('pty-1', 5_000).since).toBe(1_000)
  })

  it('starts a new clock once the pane withdraws the claim', () => {
    const gained = new PiAskDialogScreenGained()
    gained.observeClaim('pty-1', 1_000)
    gained.forget('pty-1')
    expect(gained.observeClaim('pty-1', 6_000).since).toBe(6_000)
  })
})
