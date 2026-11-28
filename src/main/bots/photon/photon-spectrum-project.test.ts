import { describe, expect, it } from 'vitest'
import { probePhotonSpectrumProject, type PhotonSpectrumFetch } from './photon-spectrum-project'

const pair = { projectId: 'pho_prj_1', projectSecret: 'pho_sk_project_secret' }

/** What Spectrum Cloud answers, keyed by the path that was asked for. */
function spectrumAnswering(byPath: Record<string, Response>): PhotonSpectrumFetch {
  return async (input) => {
    const path = new URL(input).pathname
    return byPath[path] ?? new Response('{}', { status: 404 })
  }
}

const projectRead = (data: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ succeed: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

const platformsRead = (data: Record<string, { enabled: boolean }>): Response =>
  new Response(JSON.stringify({ succeed: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

describe('probing a Spectrum project with its own pair', () => {
  it('proves the pair with a Basic-auth project read and keeps its id, name and slug', async () => {
    const seen: { url: string; authorization: string | null }[] = []
    const fetchImpl: PhotonSpectrumFetch = async (input, init) => {
      seen.push({
        url: input,
        authorization: new Headers(init.headers).get('authorization')
      })
      return new URL(input).pathname.endsWith('/platforms/')
        ? platformsRead({ imessage: { enabled: true } })
        : projectRead({ id: 'pho_prj_1', name: 'Support', slug: 'support-1a2b' })
    }

    expect(await probePhotonSpectrumProject({ ...pair, fetchImpl })).toEqual({
      projectId: 'pho_prj_1',
      name: 'Support',
      slug: 'support-1a2b'
    })
    expect(seen[0]).toEqual({
      url: 'https://spectrum.photon.codes/projects/pho_prj_1/',
      authorization: `Basic ${Buffer.from('pho_prj_1:pho_sk_project_secret').toString('base64')}`
    })
  })

  it('refuses a pair Spectrum will not accept, with copy that says which two things to paste', async () => {
    const fetchImpl = spectrumAnswering({
      '/projects/pho_prj_1/': new Response('{}', { status: 401 })
    })

    await expect(probePhotonSpectrumProject({ ...pair, fetchImpl })).rejects.toThrow(
      /refused that project id and project secret/
    )
  })

  it('refuses a project id Spectrum does not have, rather than reading it as empty', async () => {
    const fetchImpl = spectrumAnswering({
      '/projects/pho_prj_1/': new Response('{}', { status: 404 })
    })

    await expect(probePhotonSpectrumProject({ ...pair, fetchImpl })).rejects.toThrow(
      /has no project pho_prj_1/
    )
  })

  it('refuses a project with no iMessage platform: the pair is real and nothing would reach the bot', async () => {
    const fetchImpl = spectrumAnswering({
      '/projects/pho_prj_1/': projectRead({
        id: 'pho_prj_1',
        name: 'Support',
        slug: 'support-1a2b'
      }),
      '/projects/pho_prj_1/platforms/': platformsRead({ imessage: { enabled: false } })
    })

    await expect(probePhotonSpectrumProject({ ...pair, fetchImpl })).rejects.toThrow(
      /no iMessage platform enabled/
    )
  })

  it('connects anyway when the platforms answer is one this build does not read', async () => {
    // Proving the pair is the project read; a shape Orca does not know must not turn that into a refusal.
    const fetchImpl = spectrumAnswering({
      '/projects/pho_prj_1/': projectRead({
        id: 'pho_prj_1',
        name: 'Support',
        slug: 'support-1a2b'
      })
    })

    expect((await probePhotonSpectrumProject({ ...pair, fetchImpl })).slug).toBe('support-1a2b')
  })

  it('refuses a project read whose id is not the one that was pasted', async () => {
    const fetchImpl = spectrumAnswering({
      '/projects/pho_prj_1/': projectRead({ id: 'pho_prj_2', name: 'Other', slug: 'other-9z8y' })
    })

    await expect(probePhotonSpectrumProject({ ...pair, fetchImpl })).rejects.toThrow(
      /answered project pho_prj_2/
    )
  })
})
