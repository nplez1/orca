import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5'
import { attachmentIdFromUrl } from './attachment-discovery'

export type RenderedJiraHtmlOptions = {
  /** Site root. Jira's rendered HTML links and image sources are root-relative,
   *  which inside Orca would resolve against the app's own origin. */
  siteUrl?: string
  /** Resolves an attachment id to a `data:` URL, or null when it was not
   *  downloaded. Unlike an ADF media node, a rendered `<img>` names its
   *  attachment, so each one maps to exactly one image. */
  resolveImageSrc?: (attachmentId: string) => string | null
}

type JiraHtmlNode = DefaultTreeAdapterMap['node']
type JiraHtmlChild = DefaultTreeAdapterMap['childNode']
type JiraHtmlElement = DefaultTreeAdapterMap['element']
type JiraHtmlParent = DefaultTreeAdapterMap['parentNode']

function isElement(node: JiraHtmlNode): node is JiraHtmlElement {
  return 'tagName' in node
}

function isParent(node: JiraHtmlNode): node is JiraHtmlParent {
  return 'childNodes' in node
}

function readAttribute(element: JiraHtmlElement, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name === name)?.value ?? null
}

function replaceAttributes(element: JiraHtmlElement, attributes: JiraHtmlElement['attrs']): void {
  element.attrs = attributes
}

/** Swaps every attachment image for its cached data URL, in place.
 *
 *  An image whose attachment was not downloaded is replaced by its alt text: the
 *  original source is auth-protected, so keeping it would leave a broken image
 *  the renderer can never load. */
function rewriteImages(parent: JiraHtmlParent, options: RenderedJiraHtmlOptions | undefined): void {
  parent.childNodes = parent.childNodes.map((child) => {
    if (isElement(child) && child.tagName === 'img') {
      return rewriteImage(child, options)
    }
    if (isParent(child)) {
      rewriteImages(child, options)
    }
    return child
  })
}

function rewriteImage(
  element: JiraHtmlElement,
  options: RenderedJiraHtmlOptions | undefined
): JiraHtmlChild {
  const src = readAttribute(element, 'src')
  const attachmentId = src ? attachmentIdFromUrl(src) : null
  if (!attachmentId) {
    return element
  }

  const alt = (readAttribute(element, 'alt') ?? '').trim()
  const resolvedSrc = options?.resolveImageSrc?.(attachmentId) ?? null
  if (!resolvedSrc) {
    return { nodeName: '#text', value: alt, parentNode: element.parentNode }
  }
  // Why rebuilt rather than patched: Jira sizes and classes its embedded images,
  // and leaving those on a cached data URL can overflow the narrow pane.
  replaceAttributes(
    element,
    alt
      ? [
          { name: 'src', value: resolvedSrc },
          { name: 'alt', value: alt }
        ]
      : [{ name: 'src', value: resolvedSrc }]
  )
  return element
}

/** Makes root-relative targets absolute, in place.
 *
 *  Why URL resolution rather than joining: a site served under a context path
 *  emits paths that already carry it (`/jira/browse/…`), and a root-relative
 *  value resolves against the origin — joining the site URL would double the
 *  prefix. */
function absolutizeRootRelative(parent: JiraHtmlParent, siteUrl: string): void {
  for (const child of parent.childNodes) {
    if (isElement(child)) {
      for (const name of ['href', 'src']) {
        const value = readAttribute(child, name)
        if (!value || !value.startsWith('/') || value.startsWith('//')) {
          continue
        }
        let absolute: string
        try {
          absolute = new URL(value, siteUrl).toString()
        } catch {
          continue
        }
        replaceAttributes(
          child,
          child.attrs.map((attribute) =>
            attribute.name === name ? { ...attribute, value: absolute } : attribute
          )
        )
      }
    }
    if (isParent(child)) {
      absolutizeRootRelative(child, siteUrl)
    }
  }
}

/** Attachment ids that an `<img>` addresses, in document order.
 *
 *  Why not the general HTML scan: on a Server/DC body these ids are the whole
 *  download list, so a link to a non-image attachment would take one of the twelve
 *  image slots and leave a real screenshot unresolved. */
export function collectRenderedImageAttachmentIds(html: string): string[] {
  const body = html.trim()
  if (!body) {
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  const walk = (node: JiraHtmlNode): void => {
    if (!isParent(node)) {
      return
    }
    for (const child of node.childNodes) {
      if (isElement(child) && child.tagName === 'img') {
        const src = readAttribute(child, 'src')
        const id = src ? attachmentIdFromUrl(src) : null
        if (id && !seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
      walk(child)
    }
  }
  walk(parseFragment(body))
  return ids
}

/** Jira's own HTML for a body the server rendered.
 *
 *  Self-hosted Jira returns descriptions and comments as wiki markup and ships the
 *  formatted result alongside them in `renderedFields.description` / `renderedBody`.
 *  Rendering that markup as Markdown shows its macros literally (`{code}`,
 *  `{panel}`, `{*}`), so the server's own HTML is the better source — once its
 *  inline images are pointed at Orca's cached attachments and its root-relative
 *  links are made absolute.
 *
 *  Parsed with a real fragment parser rather than scanned with patterns: the
 *  markup is Jira's own, but attribute values may contain `>`, quote styles vary,
 *  and entities have to be decoded once and re-encoded once. */
export function renderedJiraHtmlToBody(html: string, options?: RenderedJiraHtmlOptions): string {
  const body = html.trim()
  if (!body) {
    return ''
  }
  const fragment = parseFragment(body)
  rewriteImages(fragment, options)
  if (options?.siteUrl) {
    absolutizeRootRelative(fragment, options.siteUrl)
  }
  return serialize(fragment).trim()
}
