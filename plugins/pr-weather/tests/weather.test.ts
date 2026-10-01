import { describe, expect, test } from 'claude-code/testing'

import type { Pr } from '../types'
import {
  classifyRollup,
  formatAge,
  formatMinutes,
  GLYPHS,
  glyph,
  isRateLimited,
  layoutBand,
  MINUTE,
  nextBackoff,
  prsFromLedger,
  quotaOf,
  repoOf,
  terminalDrawsLinks,
} from '../hooks/weather'

const base: Pr = { number: 1, url: 'https://github.com/o/r/pull/1', isDraft: false, ci: 'passed', isHeld: false }

describe('glyph priority', () => {
  test('held for approval wins over everything', async () => {
    expect(glyph({ ...base, isHeld: true, ci: 'failed', isDraft: true })).toBe(GLYPHS.held)
  })
  test('failed beats running and draft', async () => {
    expect(glyph({ ...base, ci: 'failed', isDraft: true })).toBe(GLYPHS.failed)
  })
  test('running beats draft', async () => {
    expect(glyph({ ...base, ci: 'running', isDraft: true })).toBe(GLYPHS.running)
  })
  test('a draft with passing checks is a draft', async () => {
    expect(glyph({ ...base, isDraft: true })).toBe(GLYPHS.draft)
  })
  test('passed, and no checks at all', async () => {
    expect(glyph(base)).toBe(GLYPHS.passed)
    expect(glyph({ ...base, ci: 'none' })).toBe(GLYPHS.none)
  })
})

const run = (status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', status, conclusion })
const context = (state: string) => ({ __typename: 'StatusContext', state })

describe('rollup classification', () => {
  test('no checks', async () => {
    expect(classifyRollup([])).toBe('none')
    expect(classifyRollup(null)).toBe('none')
  })
  test('failed, cancelled and timed out check runs fail', async () => {
    for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE']) {
      expect(classifyRollup([run('COMPLETED', 'SUCCESS'), run('COMPLETED', conclusion)])).toBe('failed')
    }
  })
  test('failing and erroring status contexts fail', async () => {
    expect(classifyRollup([context('FAILURE')])).toBe('failed')
    expect(classifyRollup([context('ERROR')])).toBe('failed')
  })
  test('pending, queued and in progress are running', async () => {
    expect(classifyRollup([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')])).toBe('running')
    expect(classifyRollup([run('QUEUED')])).toBe('running')
    expect(classifyRollup([context('PENDING')])).toBe('running')
    expect(classifyRollup([context('EXPECTED')])).toBe('running')
  })
  test('a failure outranks a run still going', async () => {
    expect(classifyRollup([run('IN_PROGRESS'), context('FAILURE')])).toBe('failed')
  })
  test('success, neutral and skipped pass', async () => {
    expect(classifyRollup([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED'), context('SUCCESS')])).toBe('passed')
  })
})

const line = (record: Record<string, unknown>) => JSON.stringify({ v: 1, ts: 1, ...record })
const A = 'https://github.com/o/r/pull/7'
const B = 'https://github.com/o/r/pull/8'
const C = 'https://github.com/o/r/pull/9'

describe('fleet ledger', () => {
  test('pr_ready adds the PR in ledger order', async () => {
    const text = [line({ event: 'task.pr_ready', task: 'a', pr: A }), line({ event: 'task.pr_ready', task: 'b', pr: B })].join('\n')
    expect(prsFromLedger(text)).toEqual([A, B])
  })
  test('merged removes the task, with or without a pr member', async () => {
    const text = [
      line({ event: 'task.pr_ready', task: 'a', pr: A }),
      line({ event: 'task.pr_ready', task: 'b', pr: B }),
      line({ event: 'task.merged', task: 'a', via: 'pr', pr: A }),
      line({ event: 'task.merged', task: 'b', via: 'local' }),
    ].join('\n')
    expect(prsFromLedger(text)).toEqual([])
  })
  test('cleaned_up removes the task', async () => {
    const text = [line({ event: 'task.pr_ready', task: 'a', pr: A }), line({ event: 'task.cleaned_up', task: 'a' })].join('\n')
    expect(prsFromLedger(text)).toEqual([])
  })
  test('a later pr_ready replaces the task PR, and a repeat counts once', async () => {
    const text = [
      line({ event: 'task.pr_ready', task: 'a', pr: A }),
      line({ event: 'task.pr_ready', task: 'b', pr: B }),
      line({ event: 'task.pr_ready', task: 'a', pr: C }),
      line({ event: 'task.pr_ready', task: 'b', pr: B }),
    ].join('\n')
    expect(prsFromLedger(text)).toEqual([C, B])
  })
  test('a task readied again after cleanup comes back', async () => {
    const text = [
      line({ event: 'task.pr_ready', task: 'a', pr: A }),
      line({ event: 'task.cleaned_up', task: 'a' }),
      line({ event: 'task.pr_ready', task: 'a', pr: B }),
    ].join('\n')
    expect(prsFromLedger(text)).toEqual([B])
  })
  test('torn lines, blank lines and unknown events are skipped', async () => {
    const text = [line({ event: 'task.status', task: 'a', state: 'done' }), '', line({ event: 'task.pr_ready', task: 'a', pr: A }), '{"v":1,"ev'].join('\n')
    expect(prsFromLedger(text)).toEqual([A])
  })
})

describe('repoOf', () => {
  test('reads host and owner/repo off a PR URL', async () => {
    expect(repoOf('https://github.com/acme/webapp/pull/7')).toEqual({ host: 'github.com', repo: 'acme/webapp' })
    expect(repoOf('not a url')).toBe(null)
  })
})

const many = (count: number): Pr[] => Array.from({ length: count }, (_, i) => ({ ...base, number: 100 + i, url: `u${i}` }))

describe('band layout', () => {
  // "PRs" is 3 cells and each " ☀ #100" is 7.
  test('everything shows when it fits', async () => {
    expect(layoutBand(many(3), 24, 0)).toEqual({ shown: many(3), hidden: 0 })
  })
  test('the rest are counted as +N more, and the count fits too', async () => {
    // 3 + 7 + 7 = 17, then " +2 more" needs 8: 25 > 24, so only one fits.
    const { shown, hidden } = layoutBand(many(4), 24, 0)
    expect(shown.map(pr => pr.number)).toEqual([100])
    expect(hidden).toBe(3)
  })
  test('the tail of time, notes and buttons takes its room', async () => {
    // 3 + a tail of 8 = 11, then 7 per PR, and " +2 more" is 8.
    expect(layoutBand(many(2), 25, 8).hidden).toBe(0)
    expect(layoutBand(many(3), 26, 8).hidden).toBe(2)
    expect(layoutBand(many(3), 25, 8).hidden).toBe(3)
  })
  test('a band too narrow for one PR shows only the count', async () => {
    expect(layoutBand(many(2), 5, 0)).toEqual({ shown: [], hidden: 2 })
  })
})

describe('updated-time label', () => {
  test('reads as just now, minutes, then hours', async () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(59_000)).toBe('just now')
    expect(formatAge(2 * MINUTE)).toBe('2m ago')
    expect(formatAge(59 * MINUTE + 59_000)).toBe('59m ago')
    expect(formatAge(125 * MINUTE)).toBe('2h ago')
  })
  test('durations round up to whole minutes', async () => {
    expect(formatMinutes(1)).toBe('1m')
    expect(formatMinutes(12 * MINUTE)).toBe('12m')
    expect(formatMinutes(60 * MINUTE)).toBe('1h')
    expect(formatMinutes(90 * MINUTE)).toBe('1h30m')
  })
})

const limits = (core: [number, number], graphql: [number, number]) => ({
  resources: {
    core: { limit: core[0], remaining: core[1], reset: 1000 },
    graphql: { limit: graphql[0], remaining: graphql[1], reset: 2000 },
    search: { limit: 30, remaining: 0, reset: 3000 },
  },
})

describe('quota and backoff', () => {
  test('the quota is the lower of the REST and GraphQL buckets', async () => {
    expect(quotaOf(limits([5000, 4000], [5000, 250]))).toEqual({ ratio: 0.05, remaining: 250, resetAt: 2_000_000 })
    expect(quotaOf(limits([5000, 100], [5000, 4000]))).toEqual({ ratio: 0.02, remaining: 100, resetAt: 1_000_000 })
    expect(quotaOf({})).toBe(null)
  })
  test('a healthy quota keeps the configured interval', async () => {
    expect(nextBackoff(quotaOf(limits([5000, 600], [5000, 5000])), 3 * MINUTE, 12 * MINUTE)).toBe(null)
    expect(nextBackoff(null, 3 * MINUTE, null)).toBe(null)
  })
  test('below a tenth the interval doubles each round, up to 30 minutes', async () => {
    const low = quotaOf(limits([5000, 400], [5000, 5000]))
    const rounds: (number | null)[] = []
    let backoff: number | null = null
    for (let i = 0; i < 5; i += 1) rounds.push((backoff = nextBackoff(low, 3 * MINUTE, backoff)))
    expect(rounds).toEqual([6, 12, 24, 30, 30].map(m => m * MINUTE))
  })
  test('an interval set above 30 minutes is not stretched past itself', async () => {
    const low = quotaOf(limits([5000, 0], [5000, 0]))
    expect(nextBackoff(low, 45 * MINUTE, null)).toBe(45 * MINUTE)
  })
  test('rate-limit errors are told from other failures', async () => {
    expect(isRateLimited('GraphQL: API rate limit exceeded for user ID 1.')).toBe(true)
    expect(isRateLimited('HTTP 403: You have exceeded a secondary rate limit')).toBe(true)
    expect(isRateLimited('HTTP 429: Too Many Requests')).toBe(true)
    expect(isRateLimited('HTTP 502: Bad Gateway')).toBe(false)
  })
})

describe('terminal hyperlinks', () => {
  test('known terminals link, others do not, and FORCE_HYPERLINK decides first', async () => {
    expect(terminalDrawsLinks(undefined, 'ghostty')).toBe(true)
    expect(terminalDrawsLinks(undefined, 'iTerm.app')).toBe(true)
    expect(terminalDrawsLinks(undefined, 'Apple_Terminal')).toBe(false)
    expect(terminalDrawsLinks(undefined, undefined)).toBe(false)
    expect(terminalDrawsLinks('1', 'Apple_Terminal')).toBe(true)
    expect(terminalDrawsLinks('', undefined)).toBe(true)
    expect(terminalDrawsLinks('0', 'ghostty')).toBe(false)
  })
})
