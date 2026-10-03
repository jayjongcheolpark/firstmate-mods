// The weather of the fleet's open PRs, one glyph each, in the band above the prompt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

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
import { isPrUrl, openerFor, openFailure, pressLogLine } from './open'
import type { Host, OpenResult, RunResult } from './open'
import { parseSecondMates } from './secondmates'
import type { SecondMate } from './secondmates'

const INITIAL: Status = { mode: 'auto', isRefreshing: false, isStale: false, updatedAt: null, backoffMs: null, limitedUntil: null }

const prs = atom({ plugin: 'pr-weather', key: 'prs' } as const, null)
const status = atom({ plugin: 'pr-weather', key: 'status' } as const, INITIAL)
const now = atom({ plugin: 'pr-weather', key: 'now' } as const, 0)

// At most one refresh asked for by hand per this long.
const DEBOUNCE_MS = 30_000

const TIMEOUT_MS = 30_000
const PR_FIELDS = 'number,url,state,isDraft,headRefOid,statusCheckRollup,mergeable'
// The records prsFromLedger folds: PR events, and done statuses that name a PR.
const LEDGER_EVENTS = '"event": *"task\\.(pr_ready|merged|cleaned_up)"|"state": *"done".*https://[^"]*/pull/[0-9]+'

// Nothing to show until the person sets something up; the message says what.
class SetupNeeded extends Error {}

// GitHub refused for quota; nothing more until `resetAt`, when it is known.
class RateLimited extends Error {
  constructor(readonly resetAt?: number) {
    super('GitHub rate limit')
  }
}

type FleetTarget = { source: 'fleet'; home: string; includeSecondMates: boolean }
type Target = { source: 'mine' } | FleetTarget

type PrView = {
  number: number
  url: string
  state?: string
  isDraft: boolean
  headRefOid: string
  statusCheckRollup?: RollupItem[] | null
  mergeable?: string
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
    isConflicting: view.mergeable === 'CONFLICTING',
  }
}

// The PR URLs in one home's ledger; null when that home has no ledger.
async function ledgerUrls($: EngineInterface, home: string): Promise<string[] | null> {
  const ledger = `${home}/state/fleet-ledger.jsonl`
  if (!(await $.fs.exists(ledger))) return null
  // grep rather than $.fs.read: the ledger never rotates and can outgrow one read.
  const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(['grep', '-E', LEDGER_EVENTS, ledger], { timeoutMs: TIMEOUT_MS })
  if (exitCode === 1) return []
  if (exitCode !== 0) throw new Error(`grep exited ${exitCode}: ${stderr}`)
  // A cut answer would miss the newest records, removals among them.
  if (isStdoutTruncated) throw new Error(`the PR records of ${ledger} pass 4 MiB`)
  return prsFromLedger(stdout)
}

// The second mates registered in the home's data/secondmates.md whose homes exist on this machine.
async function discoverSecondMates($: EngineInterface, home: string): Promise<SecondMate[]> {
  const text = await $.fs.read(`${home}/data/secondmates.md`).catch(() => '')
  const mates = parseSecondMates(text).filter(mate => mate.home !== home)
  const isHere = await Promise.all(mates.map(mate => $.fs.stat(mate.home).then(stat => stat.kind === 'dir', () => false)))
  return mates.filter((_, index) => isHere[index])
}

// The union of the PR URLs in the home's ledger and its second mates' ledgers, each once.
// A home without a ledger adds a note; the band waits for setup only when no home has one.
async function fleetUrls($: EngineInterface, target: FleetTarget, notes: string[]): Promise<string[]> {
  const mates = target.includeSecondMates ? await discoverSecondMates($, target.home) : []
  const main = await ledgerUrls($, target.home)
  const lists = [main]
  for (const mate of mates) {
    const urls = await ledgerUrls($, mate.home)
    if (urls === null) {
      notes.push(`second mate ${mate.id} has no fleet ledger, so its PRs are left out: touch ${mate.home}/config/fleet-ledger`)
    }
    lists.push(urls)
  }
  const hint = `turn on firstmate's fleet ledger to see the fleet's PRs: touch ${target.home}/config/fleet-ledger`
  if (lists.every(urls => urls === null)) throw new SetupNeeded(hint)
  if (main === null) notes.push(hint)
  return [...new Set(lists.flatMap(urls => urls ?? []))]
}

// One PR's lookup. A failure other than setup or quota keeps that PR's last good weather, or leaves it out.
async function isolated(lookup: () => Promise<Pr | null>, last: Pr | undefined): Promise<Pr | null> {
  try {
    return await lookup()
  } catch (error) {
    if (error instanceof SetupNeeded || error instanceof RateLimited) throw error
    return last ?? null
  }
}

async function collect($: EngineInterface, target: Target, notes: string[], previous: Pr[]): Promise<Pr[]> {
  const last = new Map(previous.map(pr => [pr.url, pr]))
  if (target.source === 'mine') {
    const views = JSON.parse(await gh($, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '100', '--json', PR_FIELDS])) as PrView[]
    const found = await Promise.all(views.map(view => isolated(() => toPr($, view), last.get(view.url))))
    return found.filter(pr => pr !== null)
  }
  const urls = await fleetUrls($, target, notes)
  const found = await Promise.all(
    urls.map(url =>
      isolated(async () => {
        const view = JSON.parse(await gh($, ['pr', 'view', url, '--json', PR_FIELDS])) as PrView
        return view.state === 'OPEN' ? toPr($, view) : null
      }, last.get(url)),
    ),
  )
  return found.filter(pr => pr !== null)
}

// The deepest directory at or above the session's that holds firstmate's AGENTS.md and a state/.
async function findHome($: EngineInterface): Promise<string | null> {
  const found = await $.fs.ancestors({ names: ['AGENTS.md'] })
  for (const { dir, content } of [...found].reverse()) {
    if (/^# Firstmate\s*$/m.test(content) && (await $.fs.exists(`${dir}/state`))) return dir
  }
  return null
}

async function resolveTarget(
  $: EngineInterface,
  source: string,
  homeOverride: string,
  includeSecondMates: boolean,
  cwd: string,
): Promise<Target | null> {
  if (source === 'mine') {
    const inRepo = await $.process
      .run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: TIMEOUT_MS })
      .then(({ exitCode }) => exitCode === 0, () => false)
    return inRepo ? { source: 'mine' } : null
  }
  const home = homeOverride || (await findHome($))
  return home ? { source: 'fleet', home, includeSecondMates } : null
}

async function expandTilde($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  return ((await $.env.get('HOME')) ?? '') + path.slice(1)
}

const OPEN_TIMEOUT_MS = 10_000

async function readHost($: EngineInterface): Promise<Host> {
  const system = await $.process
    .run(['uname', '-s'], { timeoutMs: OPEN_TIMEOUT_MS })
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.trim() : ''), () => '')
  const isSet = (value: string | undefined) => value !== undefined && value !== ''
  const isRemote = isSet(await $.env.get('SSH_CONNECTION')) || isSet(await $.env.get('SSH_TTY')) || isSet(await $.env.get('SSH_CLIENT'))
  const hasDisplay = isSet(await $.env.get('DISPLAY')) || isSet(await $.env.get('WAYLAND_DISPLAY'))
  return { system, isRemote, hasDisplay }
}

// Opens the PR in this machine's browser and says so; where there is none to open, or it
// fails, copies its URL to the clipboard of the surface pressed on and says why.
// Each step of a press leaves a pressLogLine in the debug log.
const logPress = ($: EngineInterface, pr: Pr, opener: readonly string[] | null, result: OpenResult) =>
  $.ui.log(pressLogLine(pr, opener, result), { to: 'debug' })

async function openPr($: EngineInterface, pr: Pr, host: Host, surface: RenderSurface): Promise<void> {
  const log = (opener: readonly string[] | null, result: OpenResult) => logPress($, pr, opener, result)
  if (!isPrUrl(pr.url)) {
    log(null, { kind: 'refused' })
    $.ui.toast(`PR #${pr.number} has no GitHub URL to open`)
    return
  }
  const opener = openerFor(host, pr.url)
  let failure: string | null = null
  if (opener) {
    const result: RunResult = await $.process.run(opener, { timeoutMs: OPEN_TIMEOUT_MS }).then(
      ({ exitCode, stderr }) => ({ kind: 'exited', exitCode, stderr }),
      error => ({ kind: 'threw', error: error instanceof Error ? error.message : String(error) }),
    )
    log(opener, result)
    if (result.kind === 'exited' && result.exitCode === 0) {
      $.ui.toast(`Opened PR #${pr.number}`)
      return
    }
    failure = openFailure(opener, result)
  } else {
    log(null, { kind: 'no-opener' })
  }
  const { isCopied } = await $.ui.copy({ text: pr.url, surface })
  const copied = isCopied ? `copied PR #${pr.number} URL` : pr.url
  $.ui.toast(failure ? `${failure}; ${copied}` : isCopied ? `Copied PR #${pr.number} URL` : pr.url)
}

// What the band's buttons and the /pr-weather command drive, for the session's lifetime.
type Controller = {
  refreshNow: () => Promise<string>
  setMode: (mode: Mode) => Promise<string>
  toggleMode: () => Promise<string>
  openPr: (pr: Pr, surface: RenderSurface) => Promise<void>
}

const modeOf = (value: unknown): Mode => (value === 'manual' ? 'manual' : 'auto')

export const register: Register = (on, options) => {
  const source = options.source === 'mine' ? 'mine' : 'fleet'
  const configuredHome = String(options.home ?? '').trim()
  const everyMs = Math.max(1, Number(options.refreshMinutes) || 3) * MINUTE
  const configMode = modeOf(options.mode)
  const includeSecondMates = options.includeSecondMates !== false
  let controller: Controller | null = null
  let isTerminalLinked = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // No one is at the prompt to read the band: poll nothing.
    if (!e.isInteractive) return started
    const homeOverride = (await expandTilde($, configuredHome)).replace(/(.)\/+$/, '$1')
    const target = await resolveTarget($, source, homeOverride, includeSecondMates, e.cwd)
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
    // Read at the first press, then kept: the machine does not change under a session.
    let host: Promise<Host> | null = null
    const noted = new Set<string>()
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
        const notes: string[] = []
        const list = await collect($, target, notes, (await read($, prs)) ?? [])
        for (const note of notes.filter(note => !noted.has(note))) {
          noted.add(note)
          $.ui.log(note)
        }
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
      openPr: async (pr, surface) => {
        logPress($, pr, null, { kind: 'pressed' })
        await openPr($, pr, await (host ??= readHost($)), surface)
      },
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
          <Box key="weather" flexDirection="row">
            <Text dimColor>PRs</Text>
            {list.length === 0 && <Text dimColor> none</Text>}
            {shown.flatMap(pr => {
              const { mark, color } = glyph(pr)
              return [
                <Text key={`glyph:${pr.url}`}>
                  {' '}
                  <Text color={color}>{isLinked ? <Link href={pr.url} label={mark} /> : mark}</Text>{' '}
                </Text>,
                <Button
                  key={`pr:${pr.url}`}
                  label={`#${pr.number}`}
                  plain
                  onPress={press => void controller?.openPr(pr, press.surface)}
                />,
              ]
            })}
            {hidden > 0 && <Text dimColor>{` +${hidden} more`}</Text>}
            <Text dimColor wrap="truncate">
              {notes}
            </Text>
          </Box>
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
