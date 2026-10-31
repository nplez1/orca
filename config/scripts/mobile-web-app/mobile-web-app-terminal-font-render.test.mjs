import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  openProbeTerminal,
  startTerminalRenderFixture
} from './mobile-web-app-terminal-render-fixture.mjs'

const describeRender = mobileWebAppDependenciesPresent() ? describe : describe.skip
let fixture = null

beforeAll(async () => {
  if (mobileWebAppDependenciesPresent()) {
    fixture = await startTerminalRenderFixture()
  }
}, 600_000)

afterAll(async () => {
  await fixture?.close()
})

const openTerminal = (options) => fixture.openTerminal(options)

describeRender('terminal font startup and late painting', () => {
  it('opens on a stalled font and replaces cached fallback glyphs when it finally arrives', async (context) => {
    let releaseFont = () => {}
    const fontGate = new Promise((resolve) => {
      releaseFont = resolve
    })
    const { page } = await openTerminal({
      beforeNavigate: async (page) => {
        await page.route('**/*.woff2', async (route) => {
          await fontGate
          await route.continue()
        })
      }
    })
    try {
      expect(
        await page.evaluate(() => document.fonts.check('13px "Orca Nerd Font Symbols"', '\ue0b0'))
      ).toBe(false)
      await openProbeTerminal(page)
      const screen = page.locator('.xterm-screen')
      const writeGlyph = async (glyph) => {
        await page.evaluate(
          (value) => globalThis.__orcaTerminalProbe.write(`\x1b[?25l\x1b[2J\x1b[H${value}`),
          glyph
        )
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        )
      }
      await writeGlyph('\uf07b')
      expect(await screen.locator('canvas').count()).toBeGreaterThan(0)
      const box = await screen.boundingBox()
      expect(box).toBeTruthy()
      const clip = { x: box.x, y: box.y, width: 20, height: 20 }
      // Playwright screenshots wait for fonts, which would hide the stalled-font frame.
      const cdp = await page.context().newCDPSession(page)
      const capture = async () => {
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { ...clip, scale: 1 }
        })
        return Buffer.from(data, 'base64')
      }
      const before = await capture()
      await writeGlyph('\u0378')
      const unassignedGlyph = await capture()
      context.skip(
        !unassignedGlyph.equals(before),
        'a system font already draws U+F07B (U+0378 is tofu), so the stalled frame has no fallback glyph to repaint'
      )
      await writeGlyph('\uf07b')
      releaseFont()
      await page.waitForFunction(
        () => document.fonts.check('13px "Orca Nerd Font Symbols"', '\ue0b0'),
        undefined,
        { timeout: 30_000, polling: 50 }
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      const after = await capture()
      expect(after.equals(before), 'the folder glyph must repaint after the font arrives').toBe(
        false
      )
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors)).toEqual([])
    } finally {
      releaseFont()
      await page.close()
    }
  }, 300_000)

  it('still opens under an older shell that refuses fonts', async () => {
    const { page } = await openTerminal({
      beforeNavigate: async (page) => {
        await page.route('**/*', async (route) => {
          const response = await route.fetch()
          const headers = response.headers()
          if (headers['content-security-policy']) {
            headers['content-security-policy'] = headers['content-security-policy'].replace(
              /font-src[^;]+/,
              "font-src 'none'"
            )
          }
          await route.fulfill({ response, headers })
        })
      }
    })
    try {
      await openProbeTerminal(page)
      expect(await page.locator('.xterm').count()).toBe(1)
      expect(
        await page.evaluate(() => document.fonts.check('13px "Orca Nerd Font Symbols"', '\ue0b0'))
      ).toBe(false)
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors)).toEqual([])
    } finally {
      await page.close()
    }
  }, 300_000)
})
