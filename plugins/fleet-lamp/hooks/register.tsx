import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Source } from '../types'
import { applyLines, EMPTY, lampOf } from './rules'

const latch = atom({ plugin: 'fleet-lamp', key: 'latch' } as const, EMPTY)
const offset = atom({ plugin: 'fleet-lamp', key: 'offset' } as const, null)
const source = atom({ plugin: 'fleet-lamp', key: 'source' } as const, { kind: 'none' } as Source)

const POLL_MS = 2000
// The captain's own prompt, typed or sent from a phone; never a notification, peer, schedule or plugin.
const CAPTAIN_ORIGINS = new Set(['composer', 'bridge'])

export const register: Register = (on, options) => {
  let isPolling = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = await findHome($, String(options.home ?? ''))
    if (home === null) {
      await update($, source, () => ({ kind: 'none' }) as Source)
      $.ui.log('no firstmate home above this session; set the plugin\'s "home" option to follow one', { to: 'debug' })
      return result
    }

    const tick = async () => {
      if (isPolling) {
        return
      }
      isPolling = true
      try {
        await poll($, home)
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
    const isOn = (await read($, source)).kind === 'enabled'
    if (e.props.hasSurvey || !isOn || lamp === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const more = lamp.count > 1 ? `  +${lamp.count - 1} more` : ''

    if (lamp.color === 'red') {
      const { task, state, reason } = lamp.signal
      return (
        <Box key="lamp" flexDirection="row" width={e.props.bodyColumns}>
          <Text color="error">● </Text>
          <Text bold wrap="truncate-end">
            {task}
          </Text>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {' '}
              {state}
              {reason === '' ? '' : `: ${reason}`}
            </Text>
          </Box>
          <Text dimColor>{more}</Text>
        </Box>
      )
    }

    const { task, pr } = lamp.signal
    return (
      <Box key="lamp" flexDirection="row" width={e.props.bodyColumns}>
        <Text color="success">● </Text>
        <Text bold>PR ready </Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{pr ?? task}</Text>
        </Box>
        <Text dimColor>
          {pr === null ? '' : `  ${task}`}
          {more}
        </Text>
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

/** Reads the ledger lines appended since the saved offset and folds them into the latch. */
async function poll($: EngineInterface, home: string): Promise<void> {
  const isEnabled = await $.fs.exists(`${home}/config/fleet-ledger`)
  const now: Source = isEnabled ? { kind: 'enabled', home } : { kind: 'disabled', home }
  const was = await read($, source)
  if (was.kind !== now.kind) {
    await update($, source, () => now)
  }
  if (!isEnabled) {
    await hintOnce($, home)
    return
  }

  const ledger = `${home}/state/fleet-ledger.jsonl`
  const stat = await $.fs.stat(ledger).catch(() => undefined)
  const size = stat?.kind === 'file' ? stat.size : 0
  const saved = await read($, offset)
  // First look: start at the end, so old history does not flash red.
  if (saved === null) {
    await update($, offset, () => size)
    return
  }
  // The ledger was truncated (docs/fleet-ledger.md): later records start from the top.
  const start = size < saved ? 0 : saved
  if (size === start) {
    if (start !== saved) {
      await update($, offset, () => start)
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
  await update($, offset, () => start + new TextEncoder().encode(complete).length)
}

async function hintOnce($: EngineInterface, home: string): Promise<void> {
  const key = `hinted:${home}`
  if ((await $.store.get(key)) === true) {
    return
  }
  await $.store.set(key, true)
  $.ui.log(`the fleet ledger is off in ${home}; turn it on with: touch ${home}/config/fleet-ledger`)
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
