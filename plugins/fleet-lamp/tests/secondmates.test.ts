import { describe, expect, test } from 'claude-code/testing'

import { parseSecondMates } from '../hooks/secondmates'

const local = (id: string, home: string) =>
  `- ${id} - Own ${id} work (and its crews). Escalate through the main firstmate. (home: ${home}; scope: ${id} app; projects: ${id}; added 2026-08-05)`
const remote = (id: string, home: string) =>
  `- ${id} - Own ${id} work. (host: build-box; root: /srv/code; home: ${home}; scope: ${id}; projects: ${id}; added 2026-08-06)`

describe('secondmates.md', () => {
  test('reads every local entry in file order', () => {
    const text = ['# Second mates', '', local('constructease', '/fm/ce/'), local('docs', '/fm/docs'), ''].join('\n')
    expect(parseSecondMates(text)).toEqual([
      { id: 'constructease', home: '/fm/ce' },
      { id: 'docs', home: '/fm/docs' },
    ])
  })

  test('leaves out remote entries, relative homes, repeats and other lines', () => {
    const text = [
      remote('far', '/home/far/fm'),
      local('rel', 'fm/rel'),
      local('a', '/fm/a'),
      local('b', '/fm/a'),
      '- not an entry',
      'prose with (home: /fm/x; scope: y)',
    ].join('\n')
    expect(parseSecondMates(text)).toEqual([{ id: 'a', home: '/fm/a' }])
  })

  test('nothing registered reads as none', () => {
    expect(parseSecondMates('')).toEqual([])
  })
})
