import { ISSUE_LINK_PROVIDERS, type IssueLinkProvider } from '../../../../shared/issue-link-input'

/** The providers the workspace issue field offers.
 *
 *  GitHub is always offered: a bare number is a complete link that needs no
 *  credential, and every save path already resolves it locally. Linear and Jira
 *  are offered only once they are connected, because a save for either needs a
 *  lookup that cannot succeed while disconnected — offering them is a dead end.
 *
 *  The selected provider is always kept, so an already-linked workspace stays
 *  readable and its link stays removable after a disconnect. */
export function getOfferedIssueLinkProviders(args: {
  connected: Partial<Record<IssueLinkProvider, boolean>>
  selected: IssueLinkProvider
}): IssueLinkProvider[] {
  return ISSUE_LINK_PROVIDERS.filter(
    (provider) =>
      provider === 'github' || provider === args.selected || args.connected[provider] === true
  )
}
