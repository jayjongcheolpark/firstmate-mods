// The weather of the fleet's open PRs, one glyph each, in the band above the prompt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Mode, Pr, Status } from '../types'
import {
  classifyRollup,
  formatAge,
  formatMinutes,
  glyph,
  isRateLimited,
  layoutBand,
  MAX_BACKOFF_MS,
  MINUTE,
  nextBackoff,
  prsFromLedger,
  quotaOf,
  repoOf,
  terminalDrawsLinks,
} from './weather'
import type { Quota, RollupItem } from './weather'

const INITIAL: Status = { mode: 'auto', isRefreshing: false, isStale: false, updatedAt: null, backoffMs: null, limitedUntil: null }

const prs = atom({ plugin: 'pr-weather', key: 'prs' } as const, null)
const status = atom({ plugin: 'pr-weather', key: 'status' } as const, INITIAL)
const now = atom({ plugin: 'pr-weather', key: 'now' } as const, 0)

// At most one refresh asked for by hand per this long.
const DEBOUNCE_MS = 30_000

const TIMEOUT_MS = 30_000
const PR_FIELDS = 'number,url,state,isDraft,headRefOid,statusCheckRollup'
const LEDGER_EVENTS = '"event": *"task\\.(pr_ready|merged|cleaned_up)"'

// Nothing to show until the person sets something up; the message says what.
class SetupNeeded extends Error {}

// GitHub refused for quota; nothing more until `resetAt`, when it is known.
class RateLimited extends Error {
  constructor(readonly resetAt?: number) {
    super('GitHub rate limit')
  }
}

type Target = { source: 'mine' } | { source: 'fleet'; home: string }

type PrView = {
  number: number
  url: string
  state?: string
  isDraft: boolean
  headRefOid: string
  statusCheckRollup?: RollupItem[] | null
}

const NO_GH = 'install the GitHub CLI (gh) to see PR weather'
const NO_LOGIN = 'run `gh auth login` to see PR weather'

async function gh($: EngineInterface, args: string[]): Promise<string> {
  let result
  try {
    result = await $.process.run(['gh', ...args], { timeoutMs: TIMEOUT_MS })
  } catch (error) {
    // A timeout rejects too; gh missing is the case where even --version cannot start.
    const isMissing = await $.process.run(['gh', '--version']).then(() => false, () => true)
    throw isMissing ? new SetupNeeded(NO_GH) : error
  }
  if (result.exitCode === 4) throw new SetupNeeded(NO_LOGIN)
  if (result.exitCode !== 0 && isRateLimited(result.stderr)) throw new RateLimited()
  if (result.exitCode !== 0) throw new Error(`gh ${args[0]} exited ${result.exitCode}: ${result.stderr}`)
  return result.stdout
}

// Workflow runs on the head commit waiting for someone to approve them.
async function isHeld($: EngineInterface, url: string, sha: string): Promise<boolean> {
  const where = repoOf(url)
  if (!where) return false
  try {
    const path = `repos/${where.repo}/actions/runs?head_sha=${sha}&per_page=100`
    const body = JSON.parse(await gh($, ['api', '--hostname', where.host, path])) as {
      workflow_runs?: { conclusion?: string | null }[]
    }
    return (body.workflow_runs ?? []).some(run => run.conclusion === 'action_required')
  } catch (error) {
    // A repository with Actions turned off answers 404: nothing is held there.
    if (error instanceof Error && !(error instanceof SetupNeeded) && error.message.includes('HTTP 404')) return false
    throw error
  }
}

// gh api rate_limit is free: it does not count against the quota it reports.
async function readQuota($: EngineInterface): Promise<Quota | null> {
  return quotaOf(JSON.parse(await gh($, ['api', 'rate_limit'])))
}

async function toPr($: EngineInterface, view: PrView): Promise<Pr> {
  return {
    number: view.number,
    url: view.url,
    isDraft: view.isDraft,
    ci: classifyRollup(view.statusCheckRollup),
    isHeld: await isHeld($, view.url, view.headRefOid),
  }
}

async function fleetUrls($: EngineInterface, home: string): Promise<string[]> {
  const ledger = `${home}/state/fleet-ledger.jsonl`
  if (!(await $.fs.exists(ledger))) {
    throw new SetupNeeded(`turn on firstmate's fleet ledger to see the fleet's PRs: touch ${home}/config/fleet-ledger`)
  }
  // grep rather than $.fs.read: the ledger never rotates and can outgrow one read.
  const { exitCode, stdout, stderr } = await $.process.run(['grep', '-E', LEDGER_EVENTS, ledger], { timeoutMs: TIMEOUT_MS })
  if (exitCode === 1) return []
  if (exitCode !== 0) throw new Error(`grep exited ${exitCode}: ${stderr}`)
  return prsFromLedger(stdout)
}

async function collect($: EngineInterface, target: Target): Promise<Pr[]> {
  if (target.source === 'mine') {
    const out = await gh($, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '100', '--json', PR_FIELDS])
    return Promise.all((JSON.parse(out) as PrView[]).map(view => toPr($, view)))
  }
  const views = await Promise.all(
    (await fleetUrls($, target.home)).map(async url => JSON.parse(await gh($, ['pr', 'view', url, '--json', PR_FIELDS])) as PrView),
  )
  return Promise.all(views.filter(view => view.state === 'OPEN').map(view => toPr($, view)))
}

// The deepest directory at or above the session's that holds firstmate's AGENTS.md and a state/.
async function findHome($: EngineInterface): Promise<string | null> {
  const found = await $.fs.ancestors({ names: ['AGENTS.md'] })
  for (const { dir, content } of [...found].reverse()) {
    if (/^# Firstmate\s*$/m.test(content) && (await $.fs.exists(`${dir}/state`))) return dir
  }
  return null
}

async function resolveTarget($: EngineInterface, source: string, homeOverride: string, cwd: string): Promise<Target | null> {
  if (source === 'mine') {
    const inRepo = await $.process
      .run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: TIMEOUT_MS })
      .then(({ exitCode }) => exitCode === 0, () => false)
    return inRepo ? { source: 'mine' } : null
  }
  const home = homeOverride || (await findHome($))
  return home ? { source: 'fleet', home } : null
}

async function expandTilde($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  return ((await $.env.get('HOME')) ?? '') + path.slice(1)
}

// What the band's buttons and the /pr-weather command drive, for the session's lifetime.
type Controller = {
  refreshNow: () => Promise<string>
  setMode: (mode: Mode) => Promise<string>
  toggleMode: () => Promise<string>
}

const modeOf = (value: unknown): Mode => (value === 'manual' ? 'manual' : 'auto')

export const register: Register = (on, options) => {
  const source = options.source === 'mine' ? 'mine' : 'fleet'
  const configuredHome = String(options.home ?? '').trim()
  const everyMs = Math.max(1, Number(options.refreshMinutes) || 3) * MINUTE
  const configMode = modeOf(options.mode)
  let controller: Controller | null = null
  let isTerminalLinked = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const homeOverride = (await expandTilde($, configuredHome)).replace(/(.)\/+$/, '$1')
    const target = await resolveTarget($, source, homeOverride, e.cwd)
    if (!target) return started
    isTerminalLinked = terminalDrawsLinks(await $.env.get('FORCE_HYPERLINK'), await $.env.get('TERM_PROGRAM'))

    // A mode switched from the band is kept until the mode setting itself changes.
    const stored = (await $.store.get('mode')) as { mode?: unknown; config?: unknown } | undefined
    const mode = stored?.config === configMode ? modeOf(stored.mode) : configMode
    await update($, status, s => ({ ...(s ?? INITIAL), mode, isRefreshing: false }))
    await update($, now, () => 0)

    let timer: Timer | null = null
    let lastAskedAt = -Infinity
    let lastHint: string | null = null
    const tick = async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      return t
    }

    // Auto mode's next round: after a rate limit resets, else the backed-off or configured interval.
    const schedule = async () => {
      timer?.cancel()
      timer = null
      const s = await read($, status)
      if (s.mode !== 'auto') return
      const t = await $.clock.now()
      const delay = s.limitedUntil !== null && s.limitedUntil > t ? s.limitedUntil - t : (s.backoffMs ?? everyMs)
      timer = $.clock.after(delay, () => void refresh())
    }

    const refresh = async () => {
      if ((await read($, status)).isRefreshing) return
      await update($, status, s => ({ ...s, isRefreshing: true }))
      let quota: Quota | null = null
      try {
        quota = await readQuota($)
        if (quota && quota.remaining === 0) throw new RateLimited(quota.resetAt)
        const list = await collect($, target)
        const t = await tick()
        lastHint = null
        await update($, prs, () => list)
        await update($, status, s => ({ ...s, isStale: false, updatedAt: t, limitedUntil: null, backoffMs: nextBackoff(quota, everyMs, s.backoffMs) }))
      } catch (error) {
        const t = await tick()
        if (error instanceof SetupNeeded) {
          await update($, prs, () => null)
          await update($, status, s => ({ ...s, isStale: false }))
          if (lastHint !== error.message) $.ui.log(error.message)
          lastHint = error.message
        } else if (error instanceof RateLimited) {
          const until = error.resetAt ?? quota?.resetAt ?? t + MAX_BACKOFF_MS
          await update($, status, s => ({ ...s, isStale: true, limitedUntil: Math.max(until, t + MINUTE) }))
        } else {
          await update($, status, s => ({ ...s, isStale: true }))
        }
      } finally {
        await update($, status, s => ({ ...s, isRefreshing: false }))
        await schedule()
      }
    }

    const setMode = async (chosen: Mode) => {
      await $.store.set('mode', { mode: chosen, config: configMode })
      await update($, status, s => ({ ...s, mode: chosen }))
      await schedule()
      return chosen === 'auto' ? `PR weather refreshes every ${formatMinutes(everyMs)}.` : 'PR weather refreshes only when asked.'
    }

    controller = {
      refreshNow: async () => {
        const t = await tick()
        const s = await read($, status)
        if (s.isRefreshing) return 'PR weather is already refreshing.'
        if (s.limitedUntil !== null && s.limitedUntil > t) {
          return `GitHub rate limit reached; PR weather refreshes again in ${formatMinutes(s.limitedUntil - t)}.`
        }
        if (t - lastAskedAt < DEBOUNCE_MS) {
          return `PR weather refreshed moments ago; try again in ${Math.ceil((lastAskedAt + DEBOUNCE_MS - t) / 1000)}s.`
        }
        lastAskedAt = t
        await refresh()
        return (await read($, status)).isStale ? 'PR weather refresh failed; showing the last good weather.' : 'PR weather refreshed.'
      },
      setMode,
      // Reads the mode at press time, so two presses before a redraw both flip it.
      toggleMode: async () => setMode((await read($, status)).mode === 'auto' ? 'manual' : 'auto'),
    }

    await $.command.register({ name: 'pr-weather', description: 'Refresh PR weather now, or switch it between auto and manual', argumentHint: 'refresh | mode auto|manual' })
    // The first load runs in either mode; manual mode just never polls after it.
    $.clock.after(0, () => void refresh())
    $.clock.every(MINUTE, () => void tick())

    return started
  })

  on('command.run', { command: 'pr-weather' }, async ($, e) => {
    if (!controller) return { text: 'PR weather is not active in this session.' }
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'refresh') return { text: await controller.refreshNow() }
    if (verb === 'mode' && (arg === 'auto' || arg === 'manual')) return { text: await controller.setMode(arg) }
    return { text: 'Usage: /pr-weather refresh | /pr-weather mode auto|manual' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    if (e.props.hasSurvey || list === null) return next(e)

    const s = await read($, status)
    const t = await read($, now)
    const notes = [
      s.updatedAt !== null ? ` updated ${formatAge(t - s.updatedAt)}` : '',
      s.isStale ? ' (stale)' : '',
      s.limitedUntil !== null && s.limitedUntil > t
        ? ` rate-limited, resets in ${formatMinutes(s.limitedUntil - t)}`
        : s.mode === 'auto' && s.backoffMs !== null
          ? ` low quota, every ${formatMinutes(s.backoffMs)}`
          : '',
    ].join('')
    const refreshLabel = s.isRefreshing ? '…' : '↻'
    // Each terminal Button draws as "[ label ]", with a space before it.
    const tail = (list.length === 0 ? ' none'.length : 0) + notes.length + (refreshLabel.length + 5) + (s.mode.length + 5)
    // The terminal draws its [-] collapse control in the row's last three cells; keep one more of air.
    const columns = e.props.bodyColumns - (e.surface === 'terminal' ? 4 : 0)
    const { shown, hidden } = layoutBand(list, columns, tail)
    const isLinked = e.surface !== 'terminal' || isTerminalLinked
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text wrap="truncate">
            <Text dimColor>PRs</Text>
            {list.length === 0 && <Text dimColor> none</Text>}
            {shown.map(pr => {
              const { mark, color } = glyph(pr)
              return (
                <Text key={pr.url}>
                  {' '}
                  <Text color={color}>{mark}</Text> {isLinked ? <Link href={pr.url} label={`#${pr.number}`} /> : `#${pr.number}`}
                </Text>
              )
            })}
            {hidden > 0 && <Text dimColor>{` +${hidden} more`}</Text>}
            <Text dimColor>{notes}</Text>
          </Text>
          <Text> </Text>
          <Button key="refresh" label={refreshLabel} hotkey="r" onPress={() => void controller?.refreshNow()} />
          <Text> </Text>
          <Button key="mode" label={s.mode} hotkey="m" onPress={() => void controller?.toggleMode()} />
        </Box>
        {below}
      </Box>
    )
  })
}
