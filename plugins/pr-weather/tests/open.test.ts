import { describe, expect, test } from 'claude-code/testing'

import { isPrUrl, openerFor, openFailure, pressLogLine } from '../hooks/open'

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

describe('press feedback', () => {
  const pr = { number: 7, url: PR }

  test('the debug line names the PR, the opener argv and how it went', () => {
    expect(pressLogLine(pr, ['open', PR], { kind: 'exited', exitCode: 0, stderr: '' })).toBe(
      `pr-weather press #7 ${PR} opener=["open","${PR}"] exit=0 stderr=""`,
    )
    expect(pressLogLine(pr, ['open', PR], { kind: 'threw', error: 'timed out after 10000ms' })).toBe(
      `pr-weather press #7 ${PR} opener=["open","${PR}"] error="timed out after 10000ms"`,
    )
    expect(pressLogLine(pr, null, { kind: 'pressed' })).toBe(`pr-weather press #7 ${PR} opener=none pressed`)
    expect(pressLogLine(pr, null, { kind: 'no-opener' })).toBe(`pr-weather press #7 ${PR} opener=none copy=no-local-browser`)
  })

  test('the failure toast says the exit code, or a short error', () => {
    expect(openFailure(['open', PR], { kind: 'exited', exitCode: 1, stderr: 'boom' })).toBe('open exited 1')
    expect(openFailure(['open', PR], { kind: 'threw', error: 'spawn open ENOENT' })).toBe('open failed: spawn open ENOENT')
    expect(openFailure(['open', PR], { kind: 'threw', error: 'x'.repeat(60) })).toBe(`open failed: ${'x'.repeat(39)}…`)
  })
})
