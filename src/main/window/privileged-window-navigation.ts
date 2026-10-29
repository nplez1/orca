import { shell, type WebContents } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { isRendererDocumentNavigation } from './renderer-document-navigation'
import { relayContextualLink, forgetContextualLinkRouter } from './contextual-link-relay'

/** Route a link the renderer did not handle in-app; only a window without a router opens it in the OS browser. */
function openExternalLink(contents: WebContents, url: string): void {
  const externalUrl = normalizeExternalBrowserUrl(url)
  if (externalUrl && !relayContextualLink(contents, externalUrl)) {
    void shell.openExternal(externalUrl)
  }
}

/** Keep remote documents from inheriting an Orca window's privileged preload. */
export function installPrivilegedWindowNavigationPolicy(contents: WebContents): void {
  // A new document has to re-announce its router, and a dead renderer never will.
  contents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      forgetContextualLinkRouter(contents)
    }
  })
  contents.on('render-process-gone', () => forgetContextualLinkRouter(contents))

  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(contents, url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    // Allow own-document reloads or lazy-chunk recovery silently fails without an unload-prevented signal.
    if (isRendererDocumentNavigation(contents.getURL(), url)) {
      return
    }
    openExternalLink(contents, url)
    event.preventDefault()
  })
}
