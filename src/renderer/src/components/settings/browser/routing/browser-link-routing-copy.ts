import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../../search/settings-search'
import {
  searchKeywordTranslator,
  translateSearchKeyword
} from '../../search/settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Modifier inversion changes always-copy; use complete localized variants because sentence suffixes cannot be safely stitched across locales.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false,
  t: Translate = translate
): string {
  if (modifierInverts) {
    return t(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      "Open http(s) links in Orca's built-in browser — from anywhere in the app."
    )
  }
  return t(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    "Open http(s) links in Orca's built-in browser — from anywhere in the app. {{shortcut}} always uses your system browser.",
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/** Share destination copy with search, which indexes the alternate title because its routing mode is fixed to false. */
export function getLinkRoutingModifierTitle(
  openLinksInApp: boolean,
  t: Translate = translate
): string {
  return openLinksInApp
    ? t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleSystem',
        'Hold Shift to open in your web browser'
      )
    : t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleOrca',
        'Hold Shift to open in Orca'
      )
}

// Orca describes enabled inversion; while disabled the chord still opens the system browser.
export function getLinkRoutingModifierDescription(
  {
    openLinksInApp,
    isMac
  }: {
    openLinksInApp: boolean
    isMac: boolean
  },
  t: Translate = translate
): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
  return openLinksInApp
    ? t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionSystem',
        'Links open in Orca, so {{chord}}+click sends one to your system browser instead.',
        { chord }
      )
    : t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionOrca',
        "Links open in your system browser. When enabled, {{chord}}+click opens one in Orca's built-in browser instead.",
        { chord }
      )
}

/** Both destinations, so a search for either one finds the routing preference. */
export function getLinkRoutingDestinationKeywords(t: Translate = translate): string[] {
  return [
    t('auto.components.settings.BrowserLinkRoutingSetting.inAppOption', 'In-App Browser'),
    t('auto.components.settings.BrowserLinkRoutingSetting.systemOption', 'System Browser'),
    t(
      'auto.components.settings.BrowserLinkRoutingSetting.destinationAriaLabel',
      'Default link destination'
    )
  ]
}

/** Indexes the modifier toggle, which is built with openLinksInApp false so both titles are searchable. */
export function getLinkRoutingModifierSearchEntry(
  platform: { isMac: boolean },
  t: Translate = translate
): SettingsSearchEntry {
  const keyword = searchKeywordTranslator(t)
  return {
    title: getLinkRoutingModifierTitle(false, t),
    description: getLinkRoutingModifierDescription(
      {
        openLinksInApp: false,
        isMac: platform.isMac
      },
      t
    ),
    keywords: [
      ...keyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...keyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...keyword('auto.components.settings.browser.search.90425d313c', 'shift'),
      ...keyword('auto.components.settings.browser.search.linkRoutingModifier.routing', 'routing'),
      ...keyword(
        'auto.components.settings.browser.search.linkRoutingModifier.modifier',
        'modifier'
      ),
      ...keyword('auto.components.settings.browser.search.linkRoutingModifier.invert', 'invert'),
      ...keyword(
        'auto.components.settings.browser.search.linkRoutingModifier.opposite',
        'opposite'
      ),
      getLinkRoutingModifierTitle(true, t),
      platform.isMac ? 'cmd' : 'ctrl'
    ]
  }
}

function getLinkRoutingBackgroundTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.title',
    'Open links in the background'
  )
}

function getLinkRoutingBackgroundDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.description',
    'Links join the browser without taking focus from where you clicked.'
  )
}

export function getLinkRoutingBackgroundSearchEntry(t?: Translate): SettingsSearchEntry {
  return {
    title: getLinkRoutingBackgroundTitle(t),
    description: getLinkRoutingBackgroundDescription(t),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.2d2d995c58',
        'browser',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.bea27bac4b',
        'links',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.background',
        'background',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.focus',
        'focus',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab',
        undefined,
        t
      )
    ]
  }
}
