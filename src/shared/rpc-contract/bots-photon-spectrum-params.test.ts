import { describe, expect, it } from 'vitest'
import { PhotonSpectrumConnectParams } from './bots-photon-params'

describe('connecting a bot to an existing Spectrum project', () => {
  it('takes the bot, the project id and the project secret, trimmed of what a paste brings along', () => {
    expect(
      PhotonSpectrumConnectParams.parse({
        botId: 'b1',
        projectId: '  pho_prj_1  ',
        projectSecret: '  pho_sk_project_secret  '
      })
    ).toEqual({
      botId: 'b1',
      projectId: 'pho_prj_1',
      projectSecret: 'pho_sk_project_secret',
      // Off is the default, as the account key's own toggle is: nothing is kept that was not asked for.
      storesSecret: false
    })
  })

  it('keeps the secret only when the owner asked, which is a choice rather than a prerequisite', () => {
    expect(
      PhotonSpectrumConnectParams.parse({
        botId: 'b1',
        projectId: 'pho_prj_1',
        projectSecret: 'pho_sk_project_secret',
        storesSecret: true
      }).storesSecret
    ).toBe(true)
  })

  it('refuses a secret too short to be one, and any of the three missing', () => {
    const valid = {
      botId: 'b1',
      projectId: 'pho_prj_1',
      projectSecret: 'pho_sk_project_secret',
      storesSecret: false
    }
    expect(PhotonSpectrumConnectParams.safeParse(valid).success).toBe(true)
    expect(
      PhotonSpectrumConnectParams.safeParse({ ...valid, projectSecret: 'pho_sk_' }).success
    ).toBe(false)
    expect(PhotonSpectrumConnectParams.safeParse({ ...valid, projectId: '   ' }).success).toBe(
      false
    )
    expect(PhotonSpectrumConnectParams.safeParse({ ...valid, botId: '' }).success).toBe(false)
  })
})
