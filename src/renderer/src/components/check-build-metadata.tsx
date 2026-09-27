import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PRCheckBuild } from '../../../shared/github/check-types'

/** Compact build duration: `4m 12s`, `1h 3m`, `12s`. */
export function formatBuildDuration(ms: number): string {
  if (ms <= 0) {
    return '0s'
  }
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function MetadataRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{children}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Build-level facts a CI provider reports that have no home in the GitHub-shaped check fields.
 *
 * Why a component rather than provider prose: these are assembled by Orca, not written by the
 * provider, so they have to reach the renderer as data and be labelled through `translate()`.
 */
export function CheckBuildMetadata({
  build,
  className
}: {
  build: PRCheckBuild | undefined
  /** Separation from whatever sits above, since callers box or divide this block differently. */
  className?: string
}): React.JSX.Element | null {
  if (!build) {
    return null
  }
  const hasTiming = build.queuedMs !== null || build.estimatedDurationMs !== null
  const hasAnything =
    build.number !== null ||
    build.triggeredBy !== null ||
    hasTiming ||
    build.parameters.length > 0 ||
    build.commits.length > 0
  if (!hasAnything) {
    return null
  }

  return (
    <div className={cn('min-w-0', className)}>
      <SectionLabel>{translate('checkBuild.title', 'Build')}</SectionLabel>
      <div className="grid gap-0.5 text-[11px]">
        {build.number !== null && (
          <MetadataRow label={translate('checkBuild.number', 'Number')}>
            <span className="font-mono">#{build.number}</span>
          </MetadataRow>
        )}
        {build.triggeredBy !== null && (
          <MetadataRow label={translate('checkBuild.triggeredBy', 'Triggered by')}>
            {build.triggeredBy}
          </MetadataRow>
        )}
        {build.queuedMs !== null && (
          <MetadataRow label={translate('checkBuild.queued', 'Queued')}>
            {formatBuildDuration(build.queuedMs)}
          </MetadataRow>
        )}
        {build.estimatedDurationMs !== null && (
          <MetadataRow label={translate('checkBuild.estimated', 'Estimated')}>
            {formatBuildDuration(build.estimatedDurationMs)}
          </MetadataRow>
        )}
      </div>

      {build.parameters.length > 0 && (
        <div className="mt-2 min-w-0">
          <SectionLabel>{translate('checkBuild.parameters', 'Parameters')}</SectionLabel>
          <div className="grid gap-0.5 text-[11px]">
            {build.parameters.map((parameter) => (
              <MetadataRow key={parameter.name} label={parameter.name}>
                <span className="font-mono" title={parameter.value}>
                  {parameter.value}
                </span>
              </MetadataRow>
            ))}
          </div>
        </div>
      )}

      {build.commits.length > 0 && (
        <div className="mt-2 min-w-0">
          <SectionLabel>{translate('checkBuild.commits', 'Commits')}</SectionLabel>
          <div className="grid gap-0.5 text-[11px]">
            {build.commits.map((commit) => (
              <div key={commit.id} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {commit.id.slice(0, 8)}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-foreground"
                  title={commit.message ?? commit.id}
                >
                  {commit.message ?? commit.id}
                </span>
                {commit.author && (
                  <span className="shrink-0 text-muted-foreground">{commit.author}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
