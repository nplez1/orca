/** Renderer → main: the window routes link opens itself, so main may hand them over. */
export const contextualLinkRouterReadyChannel = 'link:routerReady'

/** Main → renderer: open this URL through the app's link-routing preference. */
export const contextualLinkOpenChannel = 'link:openContextual'
