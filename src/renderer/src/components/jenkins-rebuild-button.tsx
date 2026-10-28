import React, { useCallback, useState } from 'react'
import { LoaderCircle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { rebuildJenkinsCheck } from '@/runtime/jenkins-rebuild-client'
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
  size = 'xs'
}: {
  check: PRCheckDetail
  /** Called once a build actually started, so the surface can refresh the check. */
  onStarted?: () => void
  className?: string
  size?: 'xs' | 'sm'
}): React.JSX.Element | null {
  const [rebuilding, setRebuilding] = useState(false)
  const run = useCallback(async (): Promise<void> => {
    setRebuilding(true)
    try {
      const outcome = await rebuildJenkinsCheck(check)
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
          : translate('jenkins.rebuild.failed', 'Jenkins could not start a new build.')
      )
    } finally {
      setRebuilding(false)
    }
  }, [check, onStarted])

  if (!isJenkinsCheck(check)) {
    return null
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
      {rebuilding
        ? translate('jenkins.rebuild.rerunning', 'Rerunning…')
        : translate('jenkins.rebuild.action', 'Rerun build')}
    </Button>
  )
}
