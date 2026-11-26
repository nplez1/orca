import type { Translate } from '@/i18n/use-translate'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { RelayedHostStatusRow } from './RelayedHostStatusRow'
import {
  hostGraphOlderPeerLabel,
  hostGraphPartialLabel,
  viaOtherHostsLabel
} from './relayed-fleet-copy'
import type { RelayedFleetHost } from './use-relayed-fleet-hosts'

/**
 * The machines this one can only see through another host, as menu items.
 *
 * Why a component rather than inline JSX in the status-bar segment: that segment is upstream's file, and this
 * block is the whole of what the fork adds to it. Keeping it here turns a thirty-line insertion into one line
 * there — and one line is what a sync can reconcile without reading this.
 */
export function RelayedFleetStatusItems(args: {
  relayed: readonly RelayedFleetHost[]
  unavailablePeerCount: number
  unsupportedPeerCount: number
  t: Translate
}): React.JSX.Element | null {
  const { relayed, unavailablePeerCount, unsupportedPeerCount, t } = args
  if (relayed.length === 0 && unavailablePeerCount === 0 && unsupportedPeerCount === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {viaOtherHostsLabel(t)}
      </div>
      {relayed.map((host) => (
        <RelayedHostStatusRow
          key={host.key}
          label={host.label}
          via={host.via}
          live={host.live}
          staleMinutes={host.staleMinutes}
        />
      ))}
      {unavailablePeerCount > 0 ? (
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          {hostGraphPartialLabel(unavailablePeerCount, t)}
        </div>
      ) : null}
      {unsupportedPeerCount > 0 ? (
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          {hostGraphOlderPeerLabel(unsupportedPeerCount, t)}
        </div>
      ) : null}
    </>
  )
}
