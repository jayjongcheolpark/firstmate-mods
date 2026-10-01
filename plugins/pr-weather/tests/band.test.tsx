import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const HOME = '/home/me/firstmate'
const LEDGER = `${HOME}/state/fleet-ledger.jsonl`
const SURFACES = ['terminal', 'desktop'] as const
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} }
const MINUTE = 60_000
// The mocked clock starts here, so GitHub's reset times (epoch seconds) line up with it.
const T0 = 1_790_000_000_000

const url = (n: number) => `https://github.com/acme/webapp/pull/${n}`
const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const exit = (exitCode: number, stderr = ''): ProcessRunResult => ({ ...ok(''), exitCode, stderr })
const ready = (task: string, n: number) => JSON.stringify({ v: 1, ts: 1, event: 'task.pr_ready', task, pr: url(n) })
const success = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }
const failure = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }
const view7 = (checks: object[] = [success]) =>
  ok(JSON.stringify({ number: 7, url: url(7), state: 'OPEN', isDraft: false, headRefOid: 'sha7', statusCheckRollup: checks }))
const noRuns = ok('{"workflow_runs":[]}')
const noQuota = ok('{"resources":{}}')
const MATE = '/home/me/fm-ce'
const entry = (id: string, home: string) => `- ${id} - Own ${id} work. (home: ${home}; scope: ${id}; projects: ${id}; added 2026-08-05)`
const remoteEntry = (id: string, home: string) =>
  `- ${id} - Own ${id} work. (host: box; root: /srv; home: ${home}; scope: ${id}; projects: ${id}; added 2026-08-05)`

type View = { state?: string; isDraft?: boolean; checks?: object[]; held?: boolean }

type World = {
  isFirstmate?: boolean
  isRepo?: boolean
  hasLedger?: boolean
  ledger?: string[]
  // Second mate homes on this machine and their ledger lines; null: no ledger there.
  mates?: Record<string, string[] | null>
  // data/secondmates.md in the home; absent: no file.
  registry?: string
  views?: Record<number, View>
  // What gh api rate_limit reports, of a limit of 5000.
  quota?: { remaining: number; resetAt: number }
  store?: Record<string, unknown>
  env?: Record<string, string>
  // Answers every gh call, rate_limit included, in place of the views and quota above.
  gh?: (argv: readonly string[]) => ProcessRunResult | Promise<ProcessRunResult>
}

// The engine beneath the plugin: a firstmate home on disk, its ledger, and gh.
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, w.store ?? {})
  mock.env(on, w.env ?? {})
  const logs: string[] = []
  const runs: string[][] = []
  const views = w.views ?? {}

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.ancestors', () => ({
    value: w.isFirstmate === false ? [] : [{ dir: HOME, name: 'AGENTS.md', content: '# Firstmate\n\nThe supervisor contract.', parts: [] }],
  }))
  const mates = w.mates ?? {}
  const ledgers: Record<string, string[] | undefined> = { [LEDGER]: w.hasLedger === false ? undefined : (w.ledger ?? []) }
  for (const [home, lines] of Object.entries(mates)) ledgers[`${home}/state/fleet-ledger.jsonl`] = lines ?? undefined
  on('fs.exists', ($, e) => ({ value: e.path === `${HOME}/state` || e.path in mates || ledgers[e.path] !== undefined }))
  on('fs.stat', ($, e) => {
    if (!(e.path in mates)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (e.path !== `${HOME}/data/secondmates.md` || w.registry === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: w.registry }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>prompt</Text>
  })
  const answer = async (argv: readonly string[]): Promise<ProcessRunResult> => {
    runs.push([...argv])
    if (argv[0] === 'grep') {
      const lines = ledgers[argv.at(-1) ?? '']
      return lines?.length ? ok(lines.join('\n') + '\n') : exit(1)
    }
    if (argv[0] === 'git') return w.isRepo === false ? exit(128) : ok('true\n')
    if (argv[0] !== 'gh') throw new Error(`unexpected ${argv.join(' ')}`)
    if (w.gh) return w.gh(argv)
    if (argv[1] === 'api' && argv[2] === 'rate_limit') {
      const q = w.quota ?? { remaining: 5000, resetAt: T0 + 60 * MINUTE }
      const bucket = { limit: 5000, remaining: q.remaining, reset: q.resetAt / 1000 }
      return ok(JSON.stringify({ resources: { core: bucket, graphql: bucket } }))
    }
    if (argv[1] === 'pr' && argv[2] === 'view') {
      const n = Number(/\/pull\/(\d+)$/.exec(argv[3] ?? '')?.[1])
      const v = views[n] ?? {}
      return ok(JSON.stringify({ number: n, url: url(n), state: v.state ?? 'OPEN', isDraft: v.isDraft ?? false, headRefOid: `sha${n}`, statusCheckRollup: v.checks ?? [success] }))
    }
    if (argv[1] === 'pr' && argv[2] === 'list') {
      return ok(JSON.stringify([{ number: 5, url: url(5), state: 'OPEN', isDraft: true, headRefOid: 'sha5', statusCheckRollup: [success] }]))
    }
    if (argv[1] === 'api') {
      const n = Number(/head_sha=sha(\d+)/.exec(argv.at(-1) ?? '')?.[1])
      return ok(JSON.stringify({ workflow_runs: views[n]?.held ? [{ conclusion: 'action_required' }] : [{ conclusion: 'success' }] }))
    }
    throw new Error(`unexpected ${argv.join(' ')}`)
  }
  on('process.run', async ($, e) => ({ value: await answer(e.argv) }))

  // Each refresh round starts by reading the quota.
  const rounds = () => runs.filter(argv => argv[0] === 'gh' && argv[2] === 'rate_limit').length

  return { clock, logs, runs, rounds }
}

async function start($: Engine, cwd = HOME) {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'pr-weather', surface, component: 'AbovePrompt', props: PROPS })
  const weather = await ui.find({ type: 'Text', text: /^PRs/ })
  const engine = await ui.find({ type: 'Text', text: 'prompt' })
  const links = await ui.findAll({ type: 'Link' })
  const refresh = await ui.find({ key: 'refresh' })
  const mode = await ui.find({ key: 'mode' })
  await ui.unmount()
  return {
    weather: weather?.text,
    hasEngine: engine !== undefined,
    links: links.map(link => link.props.href),
    refresh: refresh?.props.label,
    mode: mode?.props.label,
  }
}

async function press($: Engine, key: 'refresh' | 'mode') {
  const ui = await $.ui.mount({ plugin: 'pr-weather', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key })
  await ui.unmount()
}

async function command($: Engine, args: string) {
  const result = await $.command.run({ command: 'pr-weather', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  return result.text
}

describe('pr-weather band', () => {
  test('shows the fleet PRs still open, by glyph priority, each a link', async ($, on) => {
    const { clock } = world(on, {
      env: { TERM_PROGRAM: 'ghostty' },
      ledger: [ready('a', 7), ready('b', 8), ready('c', 9), ready('d', 10)],
      views: { 7: { checks: [success, failure] }, 8: { state: 'MERGED' }, 9: { isDraft: true, held: true }, 10: { isDraft: true } },
    })
    await start($)
    await clock.settle()
    for (const surface of SURFACES) {
      const drawn = await band($, surface)
      expect(drawn.weather).toBe('PRs ☂ #7 ↯ #9 ✎ #10 updated just now')
      expect(drawn.links).toEqual([url(7), url(9), url(10)])
      expect(drawn.refresh).toBe('↻')
      expect(drawn.mode).toBe('auto')
      expect(drawn.hasEngine).toBe(true)
    }
  })

  test('a terminal that cannot draw hyperlinks gets plain numbers; desktop always links', async ($, on) => {
    const { clock } = world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' }, ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    const terminal = await band($, 'terminal')
    expect(terminal.weather).toBe('PRs ☀ #7 updated just now')
    expect(terminal.links).toEqual([])
    expect((await band($, 'desktop')).links).toEqual([url(7)])
  })

  test('FORCE_HYPERLINK turns the links on in any terminal', async ($, on) => {
    const { clock } = world(on, { env: { TERM_PROGRAM: 'Kaku', FORCE_HYPERLINK: '1' }, ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    expect((await band($, 'terminal')).links).toEqual([url(7)])
  })

  test('the updated label ages between refreshes', async ($, on) => {
    const { clock } = world(on, { ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    await clock.advance(2 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated 2m ago')
    await clock.advance(MINUTE)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
  })

  test('auto refreshes on the interval and marks a failed refresh stale', async ($, on) => {
    let isDown = false
    let checks: object[] = [success]
    const { clock } = world(on, {
      ledger: [ready('a', 7)],
      gh: argv => {
        if (argv[2] === 'rate_limit') return noQuota
        if (isDown) return exit(1, 'HTTP 502: Bad Gateway')
        return argv[1] === 'api' ? noRuns : view7(checks)
      },
    })
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')

    checks = [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]
    await clock.advance(3 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☁ #7 updated just now')

    isDown = true
    await clock.advance(3 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☁ #7 updated 3m ago (stale)')
  })

  test('no open PRs still leaves the buttons', async ($, on) => {
    const { clock } = world(on, { ledger: [] })
    await start($)
    await clock.settle()
    const drawn = await band($)
    expect(drawn.weather).toBe('PRs none updated just now')
    expect(drawn.refresh).toBe('↻')
  })
})

describe('refresh modes', () => {
  test('manual loads once, never polls, and the band switches it back to auto', async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    expect(rounds()).toBe(1)

    await press($, 'mode')
    expect((await band($)).mode).toBe('manual')
    await clock.advance(30 * MINUTE)
    expect(rounds()).toBe(1)

    await press($, 'mode')
    expect((await band($)).mode).toBe('auto')
    await clock.advance(3 * MINUTE)
    expect(rounds()).toBe(2)
  })

  test('/pr-weather mode switches it too', async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    expect(await command($, 'mode manual')).toBe('PR weather refreshes only when asked.')
    await clock.advance(30 * MINUTE)
    expect(rounds()).toBe(1)
    expect(await command($, 'mode auto')).toBe('PR weather refreshes every 3m.')
    await clock.advance(3 * MINUTE)
    expect(rounds()).toBe(2)
    expect(await command($, 'mode sideways')).toBe('Usage: /pr-weather refresh | /pr-weather mode auto|manual')
  })

  test('a mode switched from the band carries into the next session', async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)], store: { mode: { mode: 'manual', config: 'auto' } } })
    await start($)
    await clock.settle()
    expect((await band($)).mode).toBe('manual')
    await clock.advance(30 * MINUTE)
    expect(rounds()).toBe(1)
  })

  test('changing the mode setting wins over an older band switch', async ($, on) => {
    const { clock } = world(on, { ledger: [ready('a', 7)], store: { mode: { mode: 'manual', config: 'manual' } } })
    await start($)
    await clock.settle()
    expect((await band($)).mode).toBe('auto')
  })

  test('the mode setting picks manual', { options: { mode: 'manual' } }, async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    expect((await band($)).mode).toBe('manual')
    await clock.advance(30 * MINUTE)
    expect(rounds()).toBe(1)
  })
})

describe('refreshing by hand', () => {
  test('refreshes at once in either mode, at most once per 30 seconds', async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)] })
    await start($)
    await clock.settle()
    await press($, 'refresh')
    expect(rounds()).toBe(2)
    await clock.advance(10_000)
    await press($, 'refresh')
    expect(rounds()).toBe(2)
    expect(await command($, 'refresh')).toBe('PR weather refreshed moments ago; try again in 20s.')
    await clock.advance(20_000)
    expect(await command($, 'refresh')).toBe('PR weather refreshed.')
    expect(rounds()).toBe(3)

    await command($, 'mode manual')
    await clock.advance(30_000)
    await press($, 'refresh')
    expect(rounds()).toBe(4)
  })

  test('shows … on the refresh button while a refresh runs', async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let isHolding = false
    const { clock } = world(on, {
      ledger: [ready('a', 7)],
      gh: async argv => {
        if (argv[2] === 'rate_limit') return noQuota
        if (argv[1] === 'api') return noRuns
        if (isHolding) await held
        return view7()
      },
    })
    await start($)
    await clock.settle()
    isHolding = true
    const pending = command($, 'refresh')
    await clock.settle()
    expect((await band($)).refresh).toBe('…')
    release()
    expect(await pending).toBe('PR weather refreshed.')
    expect((await band($)).refresh).toBe('↻')
  })
})

describe('rate-limit safety', () => {
  test('below a tenth of the quota auto mode backs off and says so', async ($, on) => {
    const { clock, rounds } = world(on, { ledger: [ready('a', 7)], quota: { remaining: 400, resetAt: T0 + 60 * MINUTE } })
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now low quota, every 6m')
    await clock.advance(3 * MINUTE)
    expect(rounds()).toBe(1)
    await clock.advance(3 * MINUTE)
    expect(rounds()).toBe(2)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now low quota, every 12m')
  })

  test('a rate-limit error marks it stale and waits for the reset', async ($, on) => {
    let isLimited = false
    const resetAt = T0 + 20 * MINUTE
    const { clock, rounds } = world(on, {
      ledger: [ready('a', 7)],
      gh: argv => {
        if (argv[2] === 'rate_limit') return ok(JSON.stringify({ resources: { core: { limit: 5000, remaining: 3000, reset: resetAt / 1000 } } }))
        if (isLimited) return exit(1, 'GraphQL: API rate limit exceeded for user ID 1.')
        return argv[1] === 'api' ? noRuns : view7()
      },
    })
    await start($)
    await clock.settle()
    isLimited = true
    await clock.advance(3 * MINUTE)
    expect(rounds()).toBe(2)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated 3m ago (stale) rate-limited, resets in 17m')
    expect(await command($, 'refresh')).toBe('GitHub rate limit reached; PR weather refreshes again in 17m.')

    isLimited = false
    await clock.advance(16 * MINUTE)
    expect(rounds()).toBe(2)
    await clock.advance(MINUTE)
    expect(rounds()).toBe(3)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
  })

  test('an empty quota skips the round and waits for the reset', async ($, on) => {
    const { clock, runs } = world(on, { ledger: [ready('a', 7)], quota: { remaining: 0, resetAt: T0 + 10 * MINUTE } })
    await start($)
    await clock.settle()
    expect(runs.some(argv => argv[2] === 'view')).toBe(false)
  })
})

describe('setup', () => {
  test('a missing gh shows nothing and one setup hint', async ($, on) => {
    const { clock, logs } = world(on, {
      ledger: [ready('a', 7)],
      gh: () => {
        throw new Error('spawn gh ENOENT')
      },
    })
    await start($)
    await clock.settle()
    await clock.advance(9 * MINUTE)
    for (const surface of SURFACES) {
      const { weather, hasEngine } = await band($, surface)
      expect(weather).toBe(undefined)
      expect(hasEngine).toBe(true)
    }
    expect(logs).toEqual(['install the GitHub CLI (gh) to see PR weather'])
  })

  test('gh not logged in shows nothing and one setup hint', async ($, on) => {
    const { clock, logs } = world(on, { ledger: [ready('a', 7)], gh: () => exit(4, 'To get started with GitHub CLI, please run:  gh auth login') })
    await start($)
    await clock.settle()
    await clock.advance(9 * MINUTE)
    expect((await band($)).weather).toBe(undefined)
    expect(logs).toEqual(['run `gh auth login` to see PR weather'])
  })

  test('without the fleet ledger it asks to turn it on and reads no PRs', async ($, on) => {
    const { clock, logs, runs } = world(on, { hasLedger: false })
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe(undefined)
    expect(logs).toEqual([`turn on firstmate's fleet ledger to see the fleet's PRs: touch ${HOME}/config/fleet-ledger`])
    expect(runs.filter(argv => argv[2] !== 'rate_limit')).toEqual([])
  })

  test('outside a firstmate session it draws and polls nothing', async ($, on) => {
    const { clock, logs, runs } = world(on, { isFirstmate: false, ledger: [ready('a', 7)] })
    await start($, '/home/me/webapp')
    await clock.settle()
    await clock.advance(9 * MINUTE)
    expect((await band($)).weather).toBe(undefined)
    expect(runs).toEqual([])
    expect(logs).toEqual([])
    expect(await command($, 'refresh')).toBe('PR weather is not active in this session.')
  })

  test('the home option follows a firstmate home from any session', { options: { home: '~/firstmate/' } }, async ($, on) => {
    const { clock } = world(on, { isFirstmate: false, env: { HOME: '/home/me' }, ledger: [ready('a', 7)] })
    await start($, '/home/me/webapp')
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
  })

  test('source mine shows your open PRs in any git repository', { options: { source: 'mine' } }, async ($, on) => {
    const { clock, runs } = world(on, { isFirstmate: false })
    await start($, '/home/me/webapp')
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ✎ #5 updated just now')
    expect(runs.some(argv => argv.join(' ').startsWith('gh pr list --author @me --state open'))).toBe(true)
  })

  test('source mine outside a git repository polls nothing', { options: { source: 'mine' } }, async ($, on) => {
    const { clock, runs } = world(on, { isFirstmate: false, isRepo: false })
    await start($, '/tmp')
    await clock.settle()
    expect((await band($)).weather).toBe(undefined)
    expect(runs.map(argv => argv[0])).toEqual(['git'])
  })
})

describe('second mate homes', () => {
  const registry = [entry('constructease', MATE), entry('gone', '/home/me/gone'), remoteEntry('far', '/home/me/far')].join('\n')

  test('unions the PRs of the home and its second mates, each once', async ($, on) => {
    const { clock, runs } = world(on, {
      ledger: [ready('a', 7), ready('b', 8)],
      registry,
      mates: { [MATE]: [ready('ce-po', 9), ready('ce-dup', 8)] },
    })
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 ☀ #8 ☀ #9 updated just now')
    expect(runs.filter(argv => argv[2] === 'view').map(argv => argv[3])).toEqual([url(7), url(8), url(9)])
    expect(runs.filter(argv => argv[0] === 'grep').map(argv => argv.at(-1))).toEqual([LEDGER, `${MATE}/state/fleet-ledger.jsonl`])
  })

  test('a second mate without a ledger is noted once and skipped', async ($, on) => {
    const { clock, logs } = world(on, { ledger: [ready('a', 7)], registry, mates: { [MATE]: null } })
    await start($)
    await clock.settle()
    await clock.advance(9 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
    expect(logs).toEqual([`second mate constructease has no fleet ledger, so its PRs are left out: touch ${MATE}/config/fleet-ledger`])
  })

  test('with the main ledger off the second mates still show, and the main hint is logged once', async ($, on) => {
    const { clock, logs } = world(on, { hasLedger: false, registry, mates: { [MATE]: [ready('ce-po', 9)] } })
    await start($)
    await clock.settle()
    await clock.advance(9 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☀ #9 updated just now')
    expect(logs).toEqual([`turn on firstmate's fleet ledger to see the fleet's PRs: touch ${HOME}/config/fleet-ledger`])
  })

  test('a second mate registered mid-session shows on the next refresh', async ($, on) => {
    const w: World = { ledger: [ready('a', 7)], mates: { [MATE]: [ready('ce-po', 9)] } }
    const { clock } = world(on, w)
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
    w.registry = entry('constructease', MATE)
    await clock.advance(3 * MINUTE)
    expect((await band($)).weather).toBe('PRs ☀ #7 ☀ #9 updated just now')
  })

  test('includeSecondMates off reads the home alone', { options: { includeSecondMates: false } }, async ($, on) => {
    const { clock, runs } = world(on, { ledger: [ready('a', 7)], registry, mates: { [MATE]: [ready('ce-po', 9)] } })
    await start($)
    await clock.settle()
    expect((await band($)).weather).toBe('PRs ☀ #7 updated just now')
    expect(runs.filter(argv => argv[0] === 'grep').map(argv => argv.at(-1))).toEqual([LEDGER])
  })
})
