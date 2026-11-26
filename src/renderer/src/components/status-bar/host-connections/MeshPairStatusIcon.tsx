import { ArrowLeftRight, ArrowRight, CircleAlert, Unlink } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { hostGroupMemberStatus } from '../../settings/runtime-environments/host-group/host-group-copy'
import type { HostGroupMemberTone } from '../../settings/runtime-environments/host-group/host-group-copy'
import type { HostMeshPairStatus } from '../../../../../shared/host-mesh/host-mesh-contract'

/**
 * One glyph beside a remote host's name saying how joined it is to the mesh.
 *
 * Why a glyph and not a label: this menu is a dense list of hosts and the pairing state is one bit the eye
 * should take in without reading a word. The words behind it are Settings', so the menu and the pane that
 * ends a pairing can never describe the same state differently.
 */
const PAIR_ICONS: Record<HostMeshPairStatus, typeof ArrowLeftRight> = {
  // Both directions exist: the shape of a mesh that is working.
  complete: ArrowLeftRight,
  // One end holds the pairing and the other does not, which is what the glyph has to make visible.
  half: ArrowRight,
  needsUpdate: CircleAlert,
  missing: Unlink
}

/**
 * Why the tone decides the colour and not the status: `complete` keeps the row's own muted colour, because a
 * colour on every healthy host is noise, and only a pair that is not joined earns a warning.
 */
const TONE_CLASS: Record<HostGroupMemberTone, string> = {
  statusSuccess: 'text-muted-foreground',
  statusWarning: 'text-status-warning',
  statusDanger: 'text-destructive'
}

export function MeshPairStatusIcon({ status }: { status: HostMeshPairStatus }): React.JSX.Element {
  const t = useTranslate()
  const { label, tone } = hostGroupMemberStatus(status, t)
  const Icon = PAIR_ICONS[status]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex shrink-0 items-center', TONE_CLASS[tone])}
    >
      <Icon aria-hidden="true" className="size-3" />
    </span>
  )
}
