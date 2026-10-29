import { describe, expect, it } from 'vitest'
import {
  allowsUnconfiguredJenkinsFetch,
  isPrivateJenkinsHost
} from './jenkins-unconfigured-host-scope'

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
    // An IPv4-mapped address is judged by the address it carries.
    expect(isPrivateJenkinsHost('::ffff:192.168.1.5')).toBe(true)
  })

  it('treats single-label and private-suffix names as private', () => {
    for (const host of ['jenkins', 'build-01', 'jenkins.internal', 'ci.corp', 'mac.local']) {
      expect(isPrivateJenkinsHost(host)).toBe(true)
    }
  })

  it('leaves public hosts alone', () => {
    for (const host of [
      'ci.example-builds.net',
      'jenkins.acme-cicd.io',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111'
    ]) {
      expect(isPrivateJenkinsHost(host)).toBe(false)
    }
  })
})

describe('allowsUnconfiguredJenkinsFetch', () => {
  it('refuses an intranet build link before any request is made', () => {
    for (const url of [
      'http://localhost:8080/job/team/job/repo/12/',
      'http://jenkins.internal/job/team/job/repo/12/',
      'http://10.0.0.5:8080/job/team/job/repo/12/',
      'http://169.254.169.254/job/team/job/repo/12/',
      'https://[fd00::1]/job/team/job/repo/12/'
    ]) {
      expect(allowsUnconfiguredJenkinsFetch(url)).toBe(false)
    }
  })

  it('keeps the public-Jenkins case the feature exists for', () => {
    expect(
      allowsUnconfiguredJenkinsFetch('https://ci.example-builds.net/job/team/job/repo/12/')
    ).toBe(true)
  })

  it('refuses anything that is not an http(s) URL', () => {
    for (const url of ['file:///etc/passwd', 'ftp://ci.example-builds.net/job/a/1/', 'not a url']) {
      expect(allowsUnconfiguredJenkinsFetch(url)).toBe(false)
    }
  })
})
