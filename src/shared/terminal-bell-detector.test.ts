import { describe, expect, it } from 'vitest'
import { createBellDetector } from './terminal-bell-detector'

describe('createBellDetector', () => {
  it('skips ANSI chunks without losing later real bells', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b[32mbuild\x1b[0m output')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it('keeps split OSC state so title terminators are not reported as bells', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b]0;Codex working')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it('treats BEL after a split non-OSC escape as a real bell', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  // Why: xterm carries 0x07 as an EXECUTABLE inside APC/DCS/PM/SOS, so a BEL
  // terminating those payloads never reaches the bell. Pi writes
  // `ESC _ pi:c BEL` on every prompt repaint; counting it announced a phantom
  // "Attention requested" notification per repaint.
  it('does not report a BEL inside an APC string (Pi-style, no ST) as a bell', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b[7m\x1b_pi:c\x07\x1b[7m')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it.each([
    ['DCS', '\x1bP1;2|payload'],
    ['PM', '\x1b^private-message'],
    ['SOS', '\x1bXstart-of-string']
  ])(
    'does not report a BEL inside a %s string (Pi-style, no ST) as a bell',
    (_name, introducer) => {
      const detector = createBellDetector()

      expect(detector.chunkContainsBell(`${introducer}\x07`)).toBe(false)
      expect(detector.chunkContainsBell('\x07')).toBe(true)
    }
  )

  it('ends a control string on an 8-bit ST (0x9c) without losing the next bell', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b_pi:c\x9c')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(true)
  })

  it('keeps APC string state across chunks', () => {
    const detector = createBellDetector()

    expect(detector.chunkContainsBell('\x1b[7m\x1b_pi:c')).toBe(false)
    expect(detector.chunkContainsBell('\x07')).toBe(false)
    expect(detector.chunkContainsBell('\x1b[7m  \x07')).toBe(true)
  })
})
