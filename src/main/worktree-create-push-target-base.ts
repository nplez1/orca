import type { GitPushTarget } from '../shared/worktree/types'

/** Only the fields a copied create needs to name its base; other callers leave them unset. */
export type CopiedPushTargetBaseRequest = {
  baseBranch?: string
  exactBranchName?: boolean
  pushTarget?: GitPushTarget
}

export type CopiedPushTargetBase = {
  baseBranch: string | undefined
  pushTarget: GitPushTarget | undefined
  /** This create added and fetched the remote, so the checkout it makes can take that branch's upstream. */
  materialized: boolean
}

/**
 * Give a copied workspace's branch somewhere to come from on the host that is creating it.
 *
 * A workspace whose branch lives on a remote Orca added on another host starts from
 * `<remote>/<branch>`, which this host has never fetched. Recreating the remote from its URL is
 * the same class of work as the clone the copy flow already does, so the copy lands on its own
 * branch instead of failing on a ref that does not exist here.
 */
export async function materializeCopiedPushTargetBase({
  request,
  prepare,
  beforePrepare
}: {
  request: CopiedPushTargetBaseRequest
  prepare: (target: GitPushTarget) => Promise<GitPushTarget>
  /** Runs once the gate passes and before the network fetch, so the surface can say it is fetching. */
  beforePrepare?: () => void
}): Promise<CopiedPushTargetBase> {
  const { exactBranchName, pushTarget, baseBranch } = request
  const remoteUrl = pushTarget?.remoteUrl?.trim()
  const remoteName = pushTarget?.remoteName.trim() ?? ''
  // Why all three: only a copied workspace starts from a remote branch, and only the URL can
  // recreate that remote here. Everything else keeps its existing base handling untouched.
  if (
    !exactBranchName ||
    !pushTarget ||
    !remoteUrl ||
    !remoteName ||
    baseBranch !== `${remoteName}/${pushTarget.branchName}`
  ) {
    return { baseBranch, pushTarget, materialized: false }
  }
  beforePrepare?.()
  const prepared = await prepare({ ...pushTarget, remoteName, remoteUrl })
  return {
    // Why the prepared name: an existing remote for that URL is reused under its own name, and a
    // taken name is suffixed, so only the prepared remote names the ref that was just fetched.
    baseBranch: `${prepared.remoteName}/${pushTarget.branchName}`,
    pushTarget: prepared,
    materialized: true
  }
}
