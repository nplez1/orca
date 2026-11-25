import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/**
 * The status bar's words for machines this host only knows about second-hand.
 *
 * Why a fork-owned file rather than more functions in upstream's `ssh-status-segment-copy`: that module is
 * upstream's, and these five strings are the fork's whole contribution to it. Keeping them here means a sync
 * never has to merge prose.
 */
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
