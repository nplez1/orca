import { collectAdfMediaAttrs, type AdfToMarkdownOptions } from './adf-markdown'
import {
  extractAttachmentContentIdsFromHtml,
  selectPreferredAttachmentIds,
  warnIfMediaResolutionIncomplete
} from './attachment-discovery'
import { collectRenderedImageAttachmentIds } from './jira-rendered-html'
import {
  createMediaMarkdownResolver,
  createRenderedImageSrcResolver,
  loadIssueImageAttachments,
  type MediaResolutionStats
} from './attachment-images'
import type { JiraClientForSite } from './authenticated-request'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'
import type { RenderedJiraHtmlOptions } from './jira-rendered-html'

export type MediaRequest = {
  attachmentField: unknown
  preferredIds: string[]
  needCount: number
  fallbackRan: boolean
  issueKey: string
}

/** Pooled: HTML/ADF selection only — no binary downloads. */
export function collectIssueMediaRequest(
  raw: JiraRecord,
  options?: { renderedHtmlOnly?: boolean }
): MediaRequest | undefined {
  const fields = asRecord(raw.fields)
  const renderedFields = asRecord(raw.renderedFields)
  const renderedHtml = asString(renderedFields.description)
  const htmlIds =
    options?.renderedHtmlOnly === true
      ? collectRenderedImageAttachmentIds(renderedHtml)
      : extractAttachmentContentIdsFromHtml(renderedHtml || undefined)
  const mediaAttrs = collectAdfMediaAttrs(fields.description)
  const selection = selectPreferredAttachmentIds({
    renderedHtmlIds: htmlIds,
    attachmentField: fields.attachment,
    mediaAttrs,
    useRenderedHtmlIdsOnly: options?.renderedHtmlOnly === true
  })
  if (selection.needCount === 0 && selection.preferredIds.length === 0) {
    return undefined
  }
  return {
    attachmentField: fields.attachment,
    preferredIds: selection.preferredIds,
    needCount: selection.needCount,
    fallbackRan: selection.fallbackRan,
    issueKey: asString(raw.key)
  }
}

export type PreparedMedia = {
  options: AdfToMarkdownOptions
  /** Same downloads, addressed by attachment id instead of ADF media node — the
   *  shape Jira's own rendered HTML needs. */
  htmlOptions: RenderedJiraHtmlOptions
  stats: MediaResolutionStats
  request: MediaRequest
}

/** Unpooled: binary downloads + resolver (outside the Jira API semaphore). */
export async function prepareMediaResolver(
  client: JiraClientForSite,
  request: MediaRequest
): Promise<PreparedMedia | undefined> {
  if (request.preferredIds.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: 0,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const images = await loadIssueImageAttachments(
    client,
    request.attachmentField,
    request.preferredIds
  )
  if (images.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: request.preferredIds.length,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const stats: MediaResolutionStats = { attachmentResolvedCount: 0 }
  const resolveMedia = createMediaMarkdownResolver(images, request.preferredIds, stats)
  return {
    options: { resolveMedia },
    htmlOptions: { resolveImageSrc: createRenderedImageSrcResolver(images, stats) },
    stats,
    request
  }
}

export function flushMediaResolutionWarn(client: JiraClientForSite, prepared: PreparedMedia): void {
  warnIfMediaResolutionIncomplete({
    siteId: client.site.id,
    issueKey: prepared.request.issueKey,
    needCount: prepared.request.needCount,
    preferredIdCount: prepared.request.preferredIds.length,
    resolvedCount: prepared.stats.attachmentResolvedCount,
    fallbackRan: prepared.request.fallbackRan
  })
}
