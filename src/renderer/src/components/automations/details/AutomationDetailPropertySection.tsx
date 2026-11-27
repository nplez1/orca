import React from 'react'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from '../automation-page-parts'

export type DetailProperty = {
  key: string
  label: string
  value: React.ReactNode
  title?: string
  mono?: boolean
}

export function DetailPropertySection({
  title,
  properties
}: {
  title: string
  properties: DetailProperty[]
}): React.JSX.Element {
  return (
    <section className="min-w-0 rounded-lg border border-border/60">
      <h3
        className={`border-b border-border/60 px-4 py-2.5 text-muted-foreground ${AUTOMATION_EDITOR_SECTION_LABEL_CLASS}`}
      >
        {title}
      </h3>
      <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2.5 px-4 py-3 text-[13px]">
        {properties.map((property) => (
          <React.Fragment key={property.key}>
            <dt className="text-muted-foreground">{property.label}</dt>
            <dd
              className={`min-w-0 break-words ${property.mono ? 'font-mono text-xs leading-5' : ''}`}
              title={property.title}
            >
              {property.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  )
}
