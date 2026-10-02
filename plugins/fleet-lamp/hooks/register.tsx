import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Followed } from '../types'
import { fitLine } from './line'
import type { LampLine } from './line'
import { applyLines, EMPTY, lampOf } from './rules'
import { parseSecondMates } from './secondmates'
import type { SecondMate } from './secondmates'

const latch = atom({ plugin: 'fleet-lamp', key: 'latch' } as const, EMPTY)
const offsets = atom({ plugin: 'fleet-lamp', key: 'offsets' } as const, {})
const followed = atom({ plugin: 'fleet-lamp', key: 'followed' } as const, [] as Followed[])

const POLL_MS = 2000
// How often data/secondmates.md is read again, so a second mate added mid-session is followed.
const DISCOVER_MS = 60_000
const MAIN_LABEL = 'main'
// The captain's own prompt, typed or sent from a phone; never a notification, peer, schedule or plugin.
const CAPTAIN_ORIGINS = new Set(['composer', 'bridge'])

export const register: Register = (on, options) => {
  let isPolling = false
  const includeSecondMates = options.includeSecondMates !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const main = await findHome($, String(options.home ?? ''))
    if (main === null) {
      await update($, followed, () => [])
      $.ui.log('no firstmate home above this session; set the plugin\'s "home" option to follow one', { to: 'debug' })
      return result
    }

    let homes: Followed[] = [{ home: main, label: MAIN_LABEL }]
    // The homes whose ledger-off hint this session has logged: once each per session.
    const hinted = new Set<string>()
    const discover = async () => {
      const mates = includeSecondMates ? await discoverSecondMates($, main) : []
      homes = [{ home: main, label: MAIN_LABEL }, ...mates.map(mate => ({ home: mate.home, label: mate.id }))]
    }

    const tick = async () => {
      if (isPolling) {
        return
      }
      isPolling = true
      try {
        const live: Followed[] = []
        for (const home of homes) {
          if (await poll($, home, home.home === main, hinted)) {
            live.push(home)
          }
        }
        if (JSON.stringify(live) !== JSON.stringify(await read($, followed))) {
          await update($, followed, () => live)
        }
      } catch (error) {
        $.ui.log(`ledger read skipped: ${String(error)}`, { to: 'debug' })
      } finally {
        isPolling = false
      }
    }
    await discover()
    await tick()
    $.clock.every(POLL_MS, () => void tick())
    $.clock.every(DISCOVER_MS, () => void discover().catch(() => undefined))
    return result
  })

  // The lamp's clear-hook: the captain has seen it.
  on('prompt.submit', async ($, e, next) => {
    if (CAPTAIN_ORIGINS.has(e.origin.kind)) {
      // One latch holds every home's signals, so this clears them all.
      await update($, latch, () => EMPTY)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lamp = lampOf(await read($, latch))
    const homes = await read($, followed)
    if (e.props.hasSurvey || homes.length === 0 || lamp === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // What the plugins beneath draw stays, above the lamp: the band is shared.
    const below = await next(e)
    const more = lamp.count > 1 ? `  +${lamp.count - 1} more` : ''
    // Which home the signal came from, once there is more than one to tell apart.
    const label = homes.length > 1 ? homes.find(followed => followed.home === lamp.signal.home)?.label : undefined
    const from = label === undefined ? '' : `${label} · `
    const isRed = lamp.color === 'red'
    const head = isRed ? '' : 'PR ready '
    const parts: LampLine = isRed
      ? { lead: `● ${from}`, main: lamp.signal.task, tail: ` ${lamp.signal.state}${lamp.signal.reason === '' ? '' : `: ${lamp.signal.reason}`}`, more }
      : {
          lead: `● ${from}${head}`,
          main: lamp.signal.pr ?? lamp.signal.task,
          tail: lamp.signal.pr === null ? '' : `  ${lamp.signal.task}`,
          more,
        }
    // The terminal draws its [-] collapse control in the row's last three cells; keep one more of air.
    const columns = e.props.bodyColumns - (e.surface === 'terminal' ? 4 : 0)
    const { main, tail } = fitLine(parts, columns)

    // One Text, fitted beforehand: the line never wraps, and no part's spacing is squeezed away.
    return (
      <Box flexDirection="column">
        {below}
        <Box key="lamp" flexDirection="row">
          <Text wrap="truncate-end">
            <Text color={isRed ? 'error' : 'success'}>●</Text> <Text dimColor>{from}</Text>
            {/* A red reads `task state: reason`; a green `PR ready <url>  task`, its task dim. */}
            <Text bold>{isRed ? main : head}</Text>
            {isRed ? tail : main}
            <Text dimColor>{isRed ? '' : tail}</Text>
            <Text dimColor>{more}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}

/**
 * The firstmate home: the configured one, else the nearest directory at or above the session's
 * working directory whose AGENTS.md names firstmate and which holds state/.
 */
async function findHome($: EngineInterface, configured: string): Promise<string | null> {
  if (configured.trim() !== '') {
    return trimSlash(await expandTilde($, configured.trim()))
  }
  const found = await $.fs.ancestors({ names: ['AGENTS.md'] })
  for (const { dir, content } of [...found].reverse()) {
    if (/firstmate/i.test(content) && (await isDir($, `${dir}/state`))) {
      return trimSlash(dir)
    }
  }
  return null
}

/**
 * Reads the lines appended to one home's ledger since its saved offset and folds them into the latch.
 * Answers whether that home's ledger is on.
 */
async function poll($: EngineInterface, { home, label }: Followed, isMain: boolean, hinted: Set<string>): Promise<boolean> {
  if (!(await $.fs.exists(`${home}/config/fleet-ledger`))) {
    if (!hinted.has(home)) {
      hinted.add(home)
      $.ui.log(
        isMain
          ? `the fleet ledger is off in ${home}; turn it on with: touch ${home}/config/fleet-ledger`
          : `the fleet ledger is off in second mate ${label} (${home}), so the lamp does not follow it; turn it on with: touch ${home}/config/fleet-ledger`,
      )
    }
    return false
  }

  const ledger = `${home}/state/fleet-ledger.jsonl`
  const stat = await $.fs.stat(ledger).catch(() => undefined)
  const size = stat?.kind === 'file' ? stat.size : 0
  const saved = (await read($, offsets))[home]
  const save = (to: number) => update($, offsets, current => ({ ...current, [home]: to }))
  // First look: start at the end, so old history does not flash red.
  if (saved === undefined) {
    await save(size)
    return true
  }
  // The ledger was truncated (docs/fleet-ledger.md): later records start from the top.
  const start = size < saved ? 0 : saved
  if (size === start) {
    if (start !== saved) {
      await save(start)
    }
    return true
  }

  // $.fs.read takes whole files of at most 4 MiB, and the ledger never rotates: tail reads the
  // appended bytes alone.
  const { exitCode, stdout } = await $.process.run(['tail', '-c', `+${start + 1}`, ledger])
  if (exitCode !== 0) {
    return true
  }
  // A partial last record waits for the next write.
  const complete = stdout.slice(0, stdout.lastIndexOf('\n') + 1)
  if (complete === '') {
    return true
  }
  await update($, latch, current => applyLines(current, complete, home))
  await save(start + new TextEncoder().encode(complete).length)
  return true
}

/** The second mates registered in `home`'s data/secondmates.md whose homes exist on this machine. */
async function discoverSecondMates($: EngineInterface, home: string): Promise<SecondMate[]> {
  const text = await $.fs.read(`${home}/data/secondmates.md`).catch(() => '')
  const mates = parseSecondMates(text).filter(mate => mate.home !== home)
  const isHere = await Promise.all(mates.map(mate => isDir($, mate.home)))
  return mates.filter((_, index) => isHere[index])
}

async function isDir($: EngineInterface, path: string): Promise<boolean> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  return stat?.kind === 'dir'
}

async function expandTilde($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) {
    return path
  }
  const home = (await $.env.get('HOME')) ?? ''
  return home + path.slice(1)
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)
