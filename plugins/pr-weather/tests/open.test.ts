import { describe, expect, test } from 'claude-code/testing'

import { isPrUrl, openerFor } from '../hooks/open'

const PR = 'https://github.com/acme/webapp/pull/7'
const mac = { system: 'Darwin', isRemote: false, hasDisplay: false }

describe('PR URLs', () => {
  test('a github.com pull request URL is accepted', () => {
    expect(isPrUrl(PR)).toBe(true)
  })

  test('anything else is refused', () => {
    for (const url of [
      'http://github.com/acme/webapp/pull/7',
      'https://github.com.evil.example/acme/webapp/pull/7',
      'https://gist.github.com/acme/webapp/pull/7',
      'https://github.com/acme/webapp/issues/7',
      'https://github.com/acme/webapp/pull/7/files',
      'https://github.com/acme/webapp/pull/7?x=1',
      'https://user@github.com/acme/webapp/pull/7',
      '-a Calculator',
      'file:///etc/passwd',
      '',
    ]) {
      expect(isPrUrl(url)).toBe(false)
    }
  })
})

describe('browser opener', () => {
  test('a local Mac opens with open', () => {
    expect(openerFor(mac, PR)).toEqual(['open', PR])
  })

  test('a local Linux desktop opens with xdg-open', () => {
    expect(openerFor({ system: 'Linux', isRemote: false, hasDisplay: true }, PR)).toEqual(['xdg-open', PR])
  })

  test('a remote session, a Linux without a desktop, or an unknown system has none', () => {
    expect(openerFor({ ...mac, isRemote: true }, PR)).toBe(null)
    expect(openerFor({ system: 'Linux', isRemote: true, hasDisplay: true }, PR)).toBe(null)
    expect(openerFor({ system: 'Linux', isRemote: false, hasDisplay: false }, PR)).toBe(null)
    expect(openerFor({ system: '', isRemote: false, hasDisplay: false }, PR)).toBe(null)
  })
})
