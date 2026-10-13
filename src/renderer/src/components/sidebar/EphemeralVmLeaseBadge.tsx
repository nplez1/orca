import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  formatEphemeralVmDeadline,
  type EphemeralVmLeaseIndicator
} from './ephemeral-vm-lease-presentation'

/**
 * How long an ephemeral host has left, in the workspace card's trailing slot.
 *
 * Why a coarse label rather than a countdown: the deadline is a provider lease measured in hours, so
 * `3h` says everything a per-second clock would. The shared visibility-gated tick underneath it is
 * already running for the other sidebar timers, so reusing it costs nothing extra — and it means the
 * label turns over within a second of the minute it changes on rather than waiting for a re-render.
 */
export function EphemeralVmLeaseBadge({
  indicator
}: {
  indicator: EphemeralVmLeaseIndicator
}): React.JSX.Element {
  const deadline = formatEphemeralVmDeadline(indicator.releaseAtMs)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why existing variants: the host-context chip is already this size and weight, and a
            destructive status pill is the repo's one treatment for "act on this now". */}
        <Badge variant={indicator.tone === 'destructive' ? 'statusDanger' : 'hostContext'}>
          {indicator.expired
            ? translate('auto.components.sidebar.WorktreeCard.ephemeralLeaseExpired', 'Expired')
            : translate(
                'auto.components.sidebar.WorktreeCard.ephemeralLeaseRemaining',
                'Exp {{value0}}',
                { value0: indicator.remaining }
              )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <div className="space-y-1">
          <div>
            {indicator.expired
              ? translate(
                  'auto.components.sidebar.WorktreeCard.ephemeralLeaseEndedAt',
                  'Lease ended {{value0}}',
                  { value0: deadline }
                )
              : translate(
                  'auto.components.sidebar.WorktreeCard.ephemeralLeaseEndsAt',
                  'Lease ends {{value0}}',
                  { value0: deadline }
                )}
          </div>
          {indicator.provider ? (
            <div className="opacity-80">
              {translate(
                'auto.components.sidebar.WorktreeCard.ephemeralLeaseProvider',
                'Provider: {{value0}}',
                { value0: indicator.provider }
              )}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
