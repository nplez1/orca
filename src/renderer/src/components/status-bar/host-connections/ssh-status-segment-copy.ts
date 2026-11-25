import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function connectedHostCountLabel(count: number, t: Translate = translate): string {
  return t('auto.components.status.bar.SshStatusSegment.connectedHostCount', '{{count}} hosts', {
    count,
    defaultValue_one: '{{count}} host'
  })
}

export function relayedHostViaLabel(reporter: string, t: Translate = translate): string {
  return t('auto.components.status.bar.SshStatusSegment.relayedHostVia', 'via {{reporter}}', {
    reporter
  })
}

export function relayedHostStaleLabel(minutes: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.SshStatusSegment.relayedHostStale',
    'not confirmed for {{minutes}} min',
    { minutes }
  )
}

export function viaOtherHostsLabel(t: Translate = translate): string {
  return t('auto.components.status.bar.SshStatusSegment.viaOtherHosts', 'Via other hosts')
}

export function hostGraphPartialLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.SshStatusSegment.hostGraphPartial',
    "{{count}} hosts didn't answer",
    { count, defaultValue_one: "{{count}} host didn't answer" }
  )
}

export function hostGraphOlderPeerLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.SshStatusSegment.hostGraphOlderPeer',
    "{{count}} hosts can't share their host list yet",
    { count, defaultValue_one: "{{count}} host can't share its host list yet" }
  )
}

export function moreSshHostsLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.SshStatusSegment.moreSshHosts',
    'Find among {{count}} more SSH hosts…',
    { count, defaultValue_one: 'Find {{count}} more SSH host…' }
  )
}

export function searchSshHostsLabel(t: Translate = translate): string {
  return t('auto.components.status.bar.SshStatusSegment.searchSshHosts', 'Search SSH hosts…')
}

export function noMatchingSshHostsLabel(t: Translate = translate): string {
  return t('auto.components.status.bar.SshStatusSegment.noMatchingSshHosts', 'No SSH hosts match.')
}

export function moreSshHostMatchesLabel(count: number): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.moreSshHostMatches',
    '{{count}} more matches. Keep typing to narrow them down.',
    { count, defaultValue_one: '{{count}} more match. Keep typing to narrow it down.' }
  )
}
