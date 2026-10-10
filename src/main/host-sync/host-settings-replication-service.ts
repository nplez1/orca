/**
 * The one-line hook a credential site calls when it changes something that replicates.
 *
 * Why this is separate from the driver that pushes: the driver imports every credential store — and
 * Electron's secret store with them — so a module that only wants to *announce* a change must not pull
 * that graph in. Importing it would also mean every test that partially mocks a single credential store
 * has to mock the whole registry.
 *
 * Why a listener rather than an import: nothing can be pushed before a host has connected, and the
 * driver is created by the connection that gives it somewhere to push to.
 */
type ReplicatedCredentialChangeListener = () => void

let listener: ReplicatedCredentialChangeListener | null = null

/** @internal — the driver registers itself when it is first used. */
export function setReplicatedCredentialChangeListener(
  next: ReplicatedCredentialChangeListener | null
): void {
  listener = next
}

/**
 * Call after any replicated credential changes on this machine.
 *
 * Why the callers are user actions and never a store's own write: the driver applies credentials it
 * receives through those same stores, so a notification from the store layer would make a host push a
 * credential straight back to the main it came from.
 *
 * The driver debounces, so a settings pane writing several fields in a row produces one delta.
 */
export function noteReplicatedCredentialChanged(): void {
  listener?.()
}
