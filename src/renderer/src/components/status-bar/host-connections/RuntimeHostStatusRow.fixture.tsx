import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'

/**
 * The mesh glyph beside a remote host's name, one fixture per pairing state it can wear.
 *
 * Why these four: the row is what a reader actually sees, so an icon that is the wrong size, the wrong colour
 * or pushes the truncated name off its line has to show up beside the real name and the real status dot.
 */
export const pairedBothWays = defineFixture({
  width: 320,
  render: () => <RuntimeHostStatusRow label="Studio" state="connected" meshStatus="complete" />
})

export const oneWay = defineFixture({
  width: 320,
  render: () => <RuntimeHostStatusRow label="Build mini" state="connected" meshStatus="half" />
})

export const needsUpdate = defineFixture({
  width: 320,
  render: () => (
    <RuntimeHostStatusRow label="Old laptop" state="connected" meshStatus="needsUpdate" />
  )
})

export const notAPairedHost = defineFixture({
  width: 320,
  render: () => <RuntimeHostStatusRow label="Plain remote server" state="disconnected" />
})
