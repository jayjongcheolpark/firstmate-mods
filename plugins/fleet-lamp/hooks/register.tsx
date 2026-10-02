import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { fitLine } from './line'
import type { LampLine } from './line'
import { applyLines, EMPTY, lampOf } from './rules'

const latch = atom({ plugin: 'fleet-lamp', key: 'latch' } as const, EMPTY)
const offsets = atom({ plugin: 'fleet-lamp', key: 'offsets' } as const, {})
const followed = atom({ plugin: 'fleet-lamp', key: 'followed' } as const, null as string | null)

const POLL_MS = 2000
// The captain's own prompt, typed or sent from a phone; never a notification, peer, schedule or plugin.
const CAPTAIN_ORIGINS = new Set(['composer', 'bridge'])

export const register: Register = (on, options) => {
  let isPolling = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // No one is at the prompt to see the lamp: follow nothing.
    if (!e.isInteractive) {
      return result
    }
    const home = await findHome($, String(options.home ?? ''))
    if (home === null) {
      await update($, followed, () => null)
      $.ui.log('no firstmate home above this session; set the plugin\'s "home" option to follow one', { to: 'debug' })
      return result
    }

    // Whether this session has logged the ledger-off hint: once per session.
    let isHinted = false
    const tick = async () => {
      if (isPolling) {
        return
      }
      isPolling = true
      try {
        const isOn = await $.fs.exists(`${home}/config/fleet-ledger`)
        if (!isOn && !isHinted) {
          isHinted = true
          $.ui.log(`the fleet ledger is off in ${home}; turn it on with: touch ${home}/config/fleet-ledger`)
        }
        const live = isOn ? home : null
        if (live !== (await read($, followed))) {
          await update($, followed, () => live)
        }
        if (isOn) {
          await poll($, home)
        }
      } catch (error) {
        $.ui.log(`ledger read skipped: ${String(error)}`, { to: 'debug' })
      } finally {
        isPolling = false
      }
    }
    await tick()
    $.clock.every(POLL_MS, () => void tick())
    return result
  })

  // The lamp's clear-hook: the captain has seen it.
  on('prompt.submit', async ($, e, next) => {
    if (CAPTAIN_ORIGINS.has(e.origin.kind)) {
      await update($, latch, () => EMPTY)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lamp = lampOf(await read($, latch))
    if (e.props.hasSurvey || (await read($, followed)) === null || lamp === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // What the plugins beneath draw stays, above the lamp: the band is shared.
    const below = await next(e)
    const more = lamp.count > 1 ? `  +${lamp.count - 1} more` : ''
    const isRed = lamp.color === 'red'
    const head = isRed ? '' : 'PR ready '
    const parts: LampLine = isRed
      ? { lead: '● ', main: lamp.signal.task, tail: ` ${lamp.signal.state}${lamp.signal.reason === '' ? '' : `: ${lamp.signal.reason}`}`, more }
      : {
          lead: `● ${head}`,
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
            <Text color={isRed ? 'error' : 'success'}>●</Text>{' '}
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
 * working directory whose AGENTS.md has a `# Firstmate` heading line and which holds state/.
 */
async function findHome($: EngineInterface, configured: string): Promise<string | null> {
  if (configured.trim() !== '') {
    return trimSlash(await expandTilde($, configured.trim()))
  }
  const found = await $.fs.ancestors({ names: ['AGENTS.md'] })
  for (const { dir, content } of [...found].reverse()) {
    if (/^# Firstmate\s*$/m.test(content) && (await isDir($, `${dir}/state`))) {
      return trimSlash(dir)
    }
  }
  return null
}

/** Reads the lines appended to the home's ledger since its saved offset and folds them into the latch. */
async function poll($: EngineInterface, home: string): Promise<void> {
  const ledger = `${home}/state/fleet-ledger.jsonl`
  const stat = await $.fs.stat(ledger).catch(() => undefined)
  const size = stat?.kind === 'file' ? stat.size : 0
  const saved = (await read($, offsets))[home]
  const save = (to: number) => update($, offsets, current => ({ ...current, [home]: to }))
  // First look: start at the end, so old history does not flash red.
  if (saved === undefined) {
    await save(size)
    return
  }
  // The ledger was truncated (docs/fleet-ledger.md): later records start from the top.
  const start = size < saved ? 0 : saved
  if (size === start) {
    if (start !== saved) {
      await save(start)
    }
    return
  }

  // $.fs.read takes whole files of at most 4 MiB, and the ledger never rotates: tail reads the
  // appended bytes alone.
  const { exitCode, stdout } = await $.process.run(['tail', '-c', `+${start + 1}`, ledger])
  if (exitCode !== 0) {
    return
  }
  // A partial last record waits for the next write.
  const complete = stdout.slice(0, stdout.lastIndexOf('\n') + 1)
  if (complete === '') {
    return
  }
  await update($, latch, current => applyLines(current, complete))
  await save(start + new TextEncoder().encode(complete).length)
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
