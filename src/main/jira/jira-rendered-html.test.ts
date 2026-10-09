import { describe, expect, it } from 'vitest'
import { collectRenderedImageAttachmentIds, renderedJiraHtmlToBody } from './jira-rendered-html'

const SITE_URL = 'https://jira.example.com'

describe('rendered Jira HTML bodies', () => {
  it('points attachment images at the cached data URL and keeps their alt text', () => {
    const body = renderedJiraHtmlToBody(
      '<p>See <img src="/secure/attachment/10001/shot.png" alt="shot.png" class="x" /></p>',
      {
        siteUrl: SITE_URL,
        resolveImageSrc: (id) => (id === '10001' ? 'data:image/png;base64,AA' : null)
      }
    )

    expect(body).toBe('<p>See <img src="data:image/png;base64,AA" alt="shot.png"></p>')
  })

  it('keeps the alt text when the attachment was not downloaded', () => {
    const body = renderedJiraHtmlToBody(
      '<p><img src="/rest/api/2/attachment/thumbnail/999/x.png" alt="missing.png" /></p>',
      { siteUrl: SITE_URL }
    )

    expect(body).toBe('<p>missing.png</p>')
  })

  it('keeps an image that is not an attachment', () => {
    const body = renderedJiraHtmlToBody('<img src="https://cdn.example.com/a.png" alt="a" />', {
      siteUrl: SITE_URL
    })

    // A void element is re-serialized without the self-closing slash.
    expect(body).toBe('<img src="https://cdn.example.com/a.png" alt="a">')
  })

  it('makes root-relative links absolute and leaves other targets alone', () => {
    const body = renderedJiraHtmlToBody(
      '<a href="/browse/ALP-1">ALP-1</a><a href="https://other.example.com/x">x</a><a href="#top">top</a>',
      { siteUrl: `${SITE_URL}/` }
    )

    expect(body).toBe(
      '<a href="https://jira.example.com/browse/ALP-1">ALP-1</a><a href="https://other.example.com/x">x</a><a href="#top">top</a>'
    )
  })

  // A context-path site emits its own prefix on every path, so joining the site
  // URL would produce /jira/jira/browse/…
  it('resolves a root-relative link on a site with a context path', () => {
    const body = renderedJiraHtmlToBody('<a href="/jira/browse/ALP-1">ALP-1</a>', {
      siteUrl: 'https://host.example.com/jira'
    })

    expect(body).toBe('<a href="https://host.example.com/jira/browse/ALP-1">ALP-1</a>')
  })

  // These four are the shapes a regex scan gets wrong when the markup is not the
  // tidy synthetic form the other cases use.
  it('does not truncate a tag at a > inside an attribute value', () => {
    const body = renderedJiraHtmlToBody(
      '<img alt="a > b" src="/secure/attachment/10001/shot.png" />',
      {
        siteUrl: SITE_URL,
        resolveImageSrc: (id) => (id === '10001' ? 'data:image/png;base64,AA' : null)
      }
    )

    expect(body).toBe('<img src="data:image/png;base64,AA" alt="a > b">')
  })

  it('reads src rather than a preceding data-src', () => {
    const body = renderedJiraHtmlToBody(
      '<img data-src="/secure/thumbnail/999/x.png" src="/secure/attachment/10001/shot.png" alt="shot" />',
      {
        siteUrl: SITE_URL,
        resolveImageSrc: (id) => (id === '10001' ? 'data:image/png;base64,AA' : null)
      }
    )

    expect(body).toBe('<img src="data:image/png;base64,AA" alt="shot">')
  })

  it('does not decode an already-escaped entity twice', () => {
    const body = renderedJiraHtmlToBody(
      '<img src="/secure/attachment/999/x.png" alt="a &amp; b" />',
      { siteUrl: SITE_URL }
    )

    expect(body).toBe('a &amp; b')
  })

  it('reads an unquoted source', () => {
    const body = renderedJiraHtmlToBody('<img src=/secure/attachment/10001/shot.png alt=shot>', {
      siteUrl: SITE_URL,
      resolveImageSrc: (id) => (id === '10001' ? 'data:image/png;base64,AA' : null)
    })

    expect(body).toBe('<img src="data:image/png;base64,AA" alt="shot">')
  })

  // A link to a non-image attachment must not take one of the twelve image slots.
  it('collects attachment ids from image sources only', () => {
    const html =
      '<a href="/secure/attachment/90001/report.pdf">report</a>' +
      '<img src="/secure/attachment/90002/shot.png" />' +
      '<img src="/secure/thumbnail/90002/shot.png" />'

    expect(collectRenderedImageAttachmentIds(html)).toEqual(['90002'])
  })

  it('renders nothing for a blank body', () => {
    expect(renderedJiraHtmlToBody('   \n ', { siteUrl: SITE_URL })).toBe('')
  })
})
