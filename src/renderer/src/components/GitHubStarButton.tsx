import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { ORCA_REPOSITORY_URL } from '../../../shared/orca-repository'
import type { OrcaStarState } from './orca-star-state'

export type GitHubStarButtonProps = {
  hasRepos: boolean
  state: OrcaStarState
  setState: React.Dispatch<React.SetStateAction<OrcaStarState>>
}

/** The "Star on GitHub" nudge shared by the landing page and the empty workspace surface. */
export function GitHubStarButton({
  hasRepos,
  state,
  setState
}: GitHubStarButtonProps): React.JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const onDocClick = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  const handleClick = async (): Promise<void> => {
    if (state === 'starred') {
      setMenuOpen((v) => !v)
      return
    }
    if (state === 'web-fallback') {
      await window.api.shell.openUrl(ORCA_REPOSITORY_URL)
      return
    }
    if (state !== 'not-starred') {
      return
    }
    setState('starred') // optimistic
    const ok = await window.api.gh.starOrca('landing')
    if (!ok) {
      if (mountedRef.current) {
        setState('web-fallback')
      }
      return
    }
    // Why: starring from any entry point mutes the threshold-based nag.
    // Without this the background notification could still fire on the next
    // threshold crossing, which would feel like a bug to the user.
    await window.api.starNag.complete()
  }

  // Hide once the user has already starred and added a repo.
  if (state === 'hidden' || (state === 'starred' && hasRepos)) {
    return null
  }

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[13px] font-medium transition-all duration-300',
          state === 'loading' && 'pointer-events-none opacity-0',
          state !== 'starred' &&
            'cursor-pointer border-amber-500/60 text-amber-700 hover:border-amber-500/80 hover:bg-amber-400/10 dark:border-amber-400/30 dark:text-amber-300/90 dark:hover:border-amber-400/50 dark:hover:bg-amber-400/[0.08]',
          state === 'starred' &&
            'cursor-pointer border-amber-500/50 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/[0.06] dark:text-amber-400/60'
        )}
        onClick={handleClick}
        onContextMenu={(event) => {
          if (state === 'starred') {
            event.preventDefault()
            setMenuOpen(true)
          }
        }}
        disabled={state === 'loading'}
      >
        {state === 'web-fallback' ? (
          <ExternalLink className="size-3.5 text-amber-600 transition-all duration-300 dark:text-amber-400/80" />
        ) : (
          <Star
            className={cn(
              'size-3.5 transition-all duration-300',
              state === 'starred'
                ? 'fill-amber-500/70 text-amber-500/70 dark:fill-amber-400/60 dark:text-amber-400/60'
                : 'text-amber-600 dark:text-amber-400/80'
            )}
          />
        )}
        {state === 'starred'
          ? translate('auto.components.Landing.ec43b38ba7', 'Starred on GitHub')
          : state === 'web-fallback'
            ? translate('auto.components.Landing.157bb5ecbb', 'Open GitHub')
            : translate('auto.components.Landing.0d0ace8861', 'Star on GitHub')}
      </button>
      {state === 'starred' && menuOpen && (
        <div className="absolute right-0 bottom-[calc(100%+4px)] z-10 min-w-[100px] rounded-md border border-border bg-popover py-1 shadow-floating">
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
            onClick={() => {
              setMenuOpen(false)
              setState('hidden')
            }}
          >
            {translate('auto.components.Landing.c1cf168479', 'Hide')}
          </button>
        </div>
      )}
    </div>
  )
}
