import { describe, expect, test } from 'claude-code/testing'

import type { Latch } from '../types'
import { apply, applyLines, EMPTY, lampOf } from '../hooks/rules'

const status = (task: string, state: string, text: string, key: string | null = null) => ({
  v: 1,
  ts: 1790133400,
  event: 'task.status',
  task,
  state,
  key,
  text,
})
const prReady = (task: string, pr: string) => ({ v: 1, ts: 1790133410, event: 'task.pr_ready', task, pr })
const fold = (...records: Record<string, unknown>[]): Latch => records.reduce<Latch>((latch, record) => apply(latch, record), EMPTY)

describe('red', () => {
  for (const state of ['needs-decision', 'blocked', 'failed']) {
    test(`a ${state} record turns it red`, () => {
      const lamp = lampOf(fold(status('fix-login', state, ' pick A or B')))
      expect(lamp).toEqual({
        color: 'red',
        signal: { task: 'fix-login', key: null, state, reason: 'pick A or B', ts: 1790133400 },
        count: 1,
      })
    })
  }

  test('working, paused and done records leave it off', () => {
    expect(lampOf(fold(status('a', 'working', ' x'), status('a', 'paused', ' y'), status('a', 'done', ' z')))).toBe(null)
  })

  test('worker validation ask-user findings stay off', () => {
    expect(lampOf(fold(status('a', 'needs-decision', ' validation ask-user findings=2 review')))).toBe(null)
  })

  test("a hold re-recorded with the captain's own answer stays off", () => {
    expect(lampOf(fold(status('a', 'needs-decision', ' held; Captain answer 2026-09-30, verbatim: ship it')))).toBe(null)
    expect(lampOf(fold(status('a', 'blocked', ' Captain 2026-09-30 verbatim: wait')))).toBe(null)
  })

  test('a keyed red turns off when a resolved record carries the same task and key', () => {
    const open = fold(status('a', 'needs-decision', ' A or B?', 'pick'))
    expect(lampOf(open)?.color).toBe('red')
    expect(lampOf(apply(open, status('a', 'resolved', ' A', 'other')))?.color).toBe('red')
    expect(lampOf(apply(open, status('b', 'resolved', ' A', 'pick')))?.color).toBe('red')
    expect(lampOf(apply(open, status('a', 'resolved', ' A', 'pick')))).toBe(null)
  })

  test('a keyless resolved record leaves a keyless red on', () => {
    const open = fold(status('a', 'blocked', ' no daemon'))
    expect(lampOf(apply(open, status('a', 'resolved', ' daemon back')))?.color).toBe('red')
  })

  test('the newest open red shows first, with the count', () => {
    const lamp = lampOf(fold(status('a', 'blocked', ' one'), status('b', 'failed', ' two', 'k')))
    expect(lamp).toMatchObject({ color: 'red', signal: { task: 'b', reason: 'two' }, count: 2 })
  })

  test('a repeated record does not stack', () => {
    const record = status('a', 'blocked', ' one')
    expect(lampOf(fold(record, record))?.count).toBe(1)
  })

  test('red outranks green', () => {
    expect(lampOf(fold(prReady('a', 'https://x/pull/1'), status('b', 'blocked', ' stuck')))?.color).toBe('red')
  })
})

describe('green', () => {
  test('a task.pr_ready record turns it green with the PR', () => {
    expect(lampOf(fold(prReady('fix-login', 'https://github.com/acme/webapp/pull/7')))).toEqual({
      color: 'green',
      signal: { task: 'fix-login', pr: 'https://github.com/acme/webapp/pull/7', ts: 1790133410 },
      count: 1,
    })
  })

  for (const text of [
    ' PR https://github.com/acme/webapp/pull/7 checks green',
    ' child api done: PR https://github.com/acme/api/pull/3',
    ' all set, PR ready: https://github.com/acme/webapp/pull/9',
  ]) {
    test(`a done record reporting a ready PR turns it green:${text}`, () => {
      const lamp = lampOf(fold(status('t', 'done', text)))
      expect(lamp?.color).toBe('green')
      expect(lamp?.signal).toMatchObject({ task: 't', pr: expect.stringMatching(/^https:\/\/github\.com\//) })
    })
  }

  test('a done record reporting the PR already merged or landed stays off', () => {
    expect(lampOf(fold(status('t', 'done', ' PR https://github.com/acme/webapp/pull/7 merged')))).toBe(null)
    expect(lampOf(fold(status('t', 'done', ' PR ready: https://github.com/acme/webapp/pull/7 landed on main')))).toBe(null)
  })

  test('a done record with no PR stays off', () => {
    expect(lampOf(fold(status('t', 'done', ' report written to docs/x.md')))).toBe(null)
  })

  test('a done record and its pr_ready for one PR count once', () => {
    const url = 'https://github.com/acme/webapp/pull/7'
    expect(lampOf(fold(status('t', 'done', ` PR ${url}`), prReady('t', url)))?.count).toBe(1)
  })
})

describe('ledger lines', () => {
  test('blank, malformed and unknown lines are ignored', () => {
    const lines = [
      '',
      'not json',
      '[1,2]',
      JSON.stringify({ v: 1, event: 'task.dispatched', task: 'a' }),
      JSON.stringify(status('a', 'blocked', ' stuck')),
      '',
    ].join('\n')
    expect(lampOf(applyLines(EMPTY, lines))?.signal).toMatchObject({ task: 'a', reason: 'stuck' })
  })
})
