import React, { useCallback, useState } from 'react'
import { LoaderCircle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { rerunJenkinsCheck, hasJenkinsApi } from '@/runtime/jenkins-rebuild-client'
import { isJenkinsCheck } from '../../../shared/jenkins-rebuild'
import type { PRCheckDetail } from '../../../shared/github/check-types'

/**
 * "Rerun build" for one Jenkins check, next to the build it belongs to.
 *
 * Why this lives beside the details rather than only in the toolbar's Rerun menu: a failed PR
 * routinely has several Jenkins jobs, and the menu reruns all of them. Starting the one you are
 * looking at is the common case, and it is also the one that has to stay available while another
 * job is starting — hence its own in-flight state rather than a shared flag.
 *
 * Renders nothing for a check Jenkins does not own, so every details surface can mount it
 * unconditionally.
 */
export function JenkinsRebuildButton({
  check,
  onStarted,
  className,
  size = 'xs',
  iconOnly = false
}: {
  check: PRCheckDetail
  /** Called once a build actually started, so the surface can refresh the check. */
  onStarted?: () => void
  className?: string
  size?: 'xs' | 'sm'
  /** Icon with a tooltip, for a check row — the label would push the row's name out of the way. */
  iconOnly?: boolean
}): React.JSX.Element | null {
  const [rebuilding, setRebuilding] = useState(false)
  const run = useCallback(async (): Promise<void> => {
    setRebuilding(true)
    try {
      const outcome = await rerunJenkinsCheck(check)
      if (!outcome.ok) {
        toast.error(outcome.error)
        return
      }
      toast.success(outcome.message)
      onStarted?.()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('jenkins.rerun.failed', 'Jenkins could not rerun this build.')
      )
    } finally {
      setRebuilding(false)
    }
  }, [check, onStarted])

  // Why also the status: a queued or running build is not something to rerun — Jenkins would run
  // the second build concurrently in the same workspace, and the useful action there is to abort.
  if (!isJenkinsCheck(check) || check.status !== 'completed' || !hasJenkinsApi()) {
    return null
  }
  const label = rebuilding
    ? translate('jenkins.rerun.rerunning', 'Rerunning…')
    : translate('jenkins.rerun.action', 'Rerun build')
  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn('size-6', className)}
            disabled={rebuilding}
            aria-busy={rebuilding}
            aria-label={translate('jenkins.rerun.action', 'Rerun build')}
            onClick={(event) => {
              // Why: the row underneath toggles the details, and rerunning is not a request to open them.
              event.stopPropagation()
              void run()
            }}
          >
            {rebuilding ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RotateCw className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      disabled={rebuilding}
      aria-busy={rebuilding}
      onClick={() => void run()}
    >
      {rebuilding ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : (
        <RotateCw className="size-3" />
      )}
      {label}
    </Button>
  )
}
