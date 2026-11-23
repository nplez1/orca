// Which App this host's bots act as, as a counter: a session that launched under one identity must start
// again under another, and nothing else about a launch tells the two apart.
let epoch = 0

/** Monotonic for this process: connecting or disconnecting the App is what moves it. */
export function appIdentityEpoch(): number {
  return epoch
}

/** Only a connect or a disconnect: a refresh re-reads the same identity, so running sessions keep theirs. */
export function advanceAppIdentityEpoch(): void {
  epoch += 1
}

export function forgetAppIdentityEpochForTests(): void {
  epoch = 0
}
