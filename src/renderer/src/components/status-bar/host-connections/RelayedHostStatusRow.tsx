import { useTranslate } from '@/i18n/use-translate'
import { statusColor } from '../../settings/ssh/targets/SshTargetCard'
import { relayedHostStaleLabel, relayedHostViaLabel } from './relayed-fleet-copy'

/**
 * A host this client can see but cannot talk to.
 *
 * Why no connect button: reaching it needs a relay, which is a later stage. Showing a control that
 * cannot work would be the dishonest version of this row.
 */
export function RelayedHostStatusRow({
  label,
  via,
  live,
  staleMinutes
}: {
  label: string
  via: string
  live: boolean
  staleMinutes: number
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span
        className={`size-1.5 shrink-0 rounded-full ${statusColor(live ? 'connected' : 'disconnected')}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{via ? relayedHostViaLabel(via, t) : null}</span>
          {!live && staleMinutes > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{relayedHostStaleLabel(staleMinutes, t)}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
