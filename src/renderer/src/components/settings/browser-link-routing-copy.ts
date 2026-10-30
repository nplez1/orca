import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Modifier inversion changes always-copy; use complete localized variants because sentence suffixes cannot be safely stitched across locales.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false
): string {
  if (modifierInverts) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      "Open http(s) links in Orca's built-in browser — from anywhere in the app."
    )
  }
  return translate(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    "Open http(s) links in Orca's built-in browser — from anywhere in the app. {{shortcut}} always uses your system browser.",
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/** Share destination copy with search, which indexes the alternate title because its routing mode is fixed to false. */
export function getLinkRoutingModifierTitle(openLinksInApp: boolean): string {
  return openLinksInApp
    ? translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleSystem',
        'Hold Shift to open in your web browser'
      )
    : translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleOrca',
        'Hold Shift to open in Orca'
      )
}

// Orca describes enabled inversion; while disabled the chord still opens the system browser.
export function getLinkRoutingModifierDescription({
  openLinksInApp,
  isMac
}: {
  openLinksInApp: boolean
  isMac: boolean
}): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
  return openLinksInApp
    ? translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionSystem',
        'Links open in Orca, so {{chord}}+click sends one to your system browser instead.',
        { chord }
      )
    : translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionOrca',
        "Links open in your system browser. When enabled, {{chord}}+click opens one in Orca's built-in browser instead.",
        { chord }
      )
}

/** Both destinations, so a search for either one finds the routing preference. */
export function getLinkRoutingDestinationKeywords(): string[] {
  return [
    translate('auto.components.settings.BrowserLinkRoutingSetting.inAppOption', 'In-App Browser'),
    translate('auto.components.settings.BrowserLinkRoutingSetting.systemOption', 'System Browser'),
    translate(
      'auto.components.settings.BrowserLinkRoutingSetting.destinationAriaLabel',
      'Default link destination'
    )
  ]
}

/** Indexes the modifier toggle, which is built with openLinksInApp false so both titles are searchable. */
export function getLinkRoutingModifierSearchEntry(platform: {
  isMac: boolean
}): SettingsSearchEntry {
  return {
    title: getLinkRoutingModifierTitle(false),
    description: getLinkRoutingModifierDescription({
      openLinksInApp: false,
      isMac: platform.isMac
    }),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword('auto.components.settings.browser.search.90425d313c', 'shift'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingModifier.routing',
        'routing'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingModifier.modifier',
        'modifier'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingModifier.invert',
        'invert'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingModifier.opposite',
        'opposite'
      ),
      getLinkRoutingModifierTitle(true),
      platform.isMac ? 'cmd' : 'ctrl'
    ]
  }
}

function getLinkRoutingBackgroundTitle(): string {
  return translate(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.title',
    'Open links in the background'
  )
}

function getLinkRoutingBackgroundDescription(): string {
  return translate(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.description',
    'Links join the browser without taking focus from where you clicked.'
  )
}

export function getLinkRoutingBackgroundSearchEntry(): SettingsSearchEntry {
  return {
    title: getLinkRoutingBackgroundTitle(),
    description: getLinkRoutingBackgroundDescription(),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.background',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.focus',
        'focus'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab'
      )
    ]
  }
}
