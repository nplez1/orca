import { describe, expect, it } from 'vitest'
import { isPrivateJenkinsHost, isPubliclyRoutableUrl } from './jenkins-unconfigured-host-scope'

const PUBLIC_ADDRESSES = ['93.184.216.34']

describe('isPrivateJenkinsHost', () => {
  it('treats loopback, link-local and RFC 1918 addresses as private', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.10',
      '100.64.0.7',
      '169.254.169.254'
    ]) {
      expect(isPrivateJenkinsHost(host)).toBe(true)
    }
  })

  it('treats IPv6 loopback, unique-local and link-local addresses as private', () => {
    for (const host of ['::1', '[::1]', 'fd00::1', '[fd00::1]', 'fe80::1', '[fe80::1]', '::']) {
      expect(isPrivateJenkinsHost(host)).toBe(true)
    }
    // An IPv4-mapped address is judged by the address it carries, in each spelling it arrives in.
    expect(isPrivateJenkinsHost('::ffff:192.168.1.5')).toBe(true)
    expect(isPrivateJenkinsHost('[::ffff:7f00:1]')).toBe(true)
    expect(isPrivateJenkinsHost('[::ffff:a00:5]')).toBe(true)
    expect(isPrivateJenkinsHost('[::ffff:5db8:d822]')).toBe(false)
  })

  it('treats single-label and private-suffix names as private', () => {
    for (const host of ['jenkins', 'build-01', 'jenkins.internal', 'ci.corp', 'mac.local']) {
      expect(isPrivateJenkinsHost(host)).toBe(true)
    }
  })

  it('leaves public hosts alone, including the addresses a text prefix would misread', () => {
    for (const host of [
      'ci.example-builds.net',
      'jenkins.acme-cicd.io',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111',
      // The first group decides the range, and neither of these is inside fc00::/7 or fe80::/10.
      'fe8::',
      'fc::',
      '[2606:4700:4700::1111]'
    ]) {
      expect(isPrivateJenkinsHost(host)).toBe(false)
    }
  })
})

describe('isPubliclyRoutableUrl', () => {
  it('refuses an intranet build link before any request is made', async () => {
    for (const url of [
      'http://localhost:8080/job/team/job/repo/12/',
      'http://jenkins.internal/job/team/job/repo/12/',
      'http://10.0.0.5:8080/job/team/job/repo/12/',
      'http://169.254.169.254/job/team/job/repo/12/',
      'https://[fd00::1]/job/team/job/repo/12/',
      // What the URL parser actually produces for a mapped address.
      'http://[::ffff:7f00:1]:8080/job/team/job/repo/12/'
    ]) {
      expect(await isPubliclyRoutableUrl(url, async () => PUBLIC_ADDRESSES)).toBe(false)
    }
  })

  it('keeps the public-Jenkins case the feature exists for', async () => {
    expect(
      await isPubliclyRoutableUrl(
        'https://ci.example-builds.net/job/team/job/repo/12/',
        async () => PUBLIC_ADDRESSES
      )
    ).toBe(true)
  })

  it('refuses a public name that resolves into a private range', async () => {
    // A split-horizon name is the ordinary intranet setup, and `10.0.0.5.nip.io` resolves to it.
    expect(
      await isPubliclyRoutableUrl('https://ci.acme-cicd.io/job/team/job/repo/12/', async () => [
        '10.0.0.5'
      ])
    ).toBe(false)
    expect(
      await isPubliclyRoutableUrl('https://ci.acme-cicd.io/job/team/job/repo/12/', async () => [
        '93.184.216.34',
        '192.168.1.7'
      ])
    ).toBe(false)
  })

  it('refuses a name it cannot resolve, because the transport resolves it again', async () => {
    // An attacker's own DNS can answer SERVFAIL/NXDOMAIN to this lookup and a private address to
    // Chromium's, so "unknown" is a refusal.
    expect(
      await isPubliclyRoutableUrl('https://ci.acme-cicd.io/job/team/job/repo/12/', async () => null)
    ).toBe(false)
  })

  it('does not resolve a literal address', async () => {
    let lookups = 0
    await isPubliclyRoutableUrl('https://93.184.216.34/job/team/job/repo/12/', async () => {
      lookups += 1
      return PUBLIC_ADDRESSES
    })
    expect(lookups).toBe(0)
  })

  it('refuses anything that is not an http(s) URL', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://ci.example-builds.net/job/a/1/', 'not a url']) {
      expect(await isPubliclyRoutableUrl(url, async () => PUBLIC_ADDRESSES)).toBe(false)
    }
  })
})
