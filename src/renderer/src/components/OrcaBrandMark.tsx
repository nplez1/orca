import logo from '../../../../resources/logo.svg'

export type OrcaBrandMarkProps = {
  logoAlt: string
  title: string
}

/**
 * The Orca tile and wordmark shared by the landing screen and an emptied workspace, so the two
 * surfaces cannot drift. Copy is passed in: each surface keeps its own catalog keys (#96).
 */
export function OrcaBrandMark({ logoAlt, title }: OrcaBrandMarkProps): React.JSX.Element {
  return (
    <>
      <div
        className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
        style={{ backgroundColor: '#12181e' }}
      >
        <img src={logo} alt={logoAlt} className="size-12" />
      </div>
      <h1 className="text-4xl font-bold text-foreground tracking-tight">{title}</h1>
    </>
  )
}
