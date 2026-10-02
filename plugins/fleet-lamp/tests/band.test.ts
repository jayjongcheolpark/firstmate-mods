import type { On, PromptOrigin, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/work/fm'
const LEDGER = `${HOME}/state/fleet-ledger.jsonl`
const FLAG = `${HOME}/config/fleet-ledger`
const MATE = '/work/ce'
const MATE_LEDGER = `${MATE}/state/fleet-ledger.jsonl`
const MATE_FLAG = `${MATE}/config/fleet-ledger`
const REGISTRY = `${HOME}/data/secondmates.md`
const entry = (id: string, home: string) => `- ${id} - Own ${id} work. (home: ${home}; scope: ${id}; projects: ${id}; added 2026-08-05)\n`
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'fleet-lamp',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const ANCESTORS = [
  { dir: '/work', name: 'AGENTS.md', content: '# Some other project', parts: [] },
  { dir: HOME, name: 'AGENTS.md', content: '# Firstmate\n\nThe supervisor contract.', parts: [] },
]

/** A firstmate home in memory: the files the mod may read, and the calls it made. */
function world(on: On, files: Record<string, string>, ancestors = ANCESTORS) {
  const logs: string[] = []
  // Every path the mod looked at, and every command it ran.
  const touched: string[] = []
  const exists = (path: string) => path in files || Object.keys(files).some(file => file.startsWith(`${path}/`))
  on('fs.exists', ($, e) => {
    touched.push(e.path)
    return { value: exists(e.path) }
  })
  on('fs.stat', ($, e) => {
    touched.push(e.path)
    if (!exists(e.path)) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    const isFile = e.path in files
    const size = isFile ? encoder.encode(files[e.path] ?? '').length : 0
    return { value: { kind: isFile ? 'file' : 'dir', size, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    touched.push(e.path)
    if (!(e.path in files)) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: files[e.path] ?? '' }
  })
  on('fs.ancestors', () => {
    touched.push('AGENTS.md')
    return { value: ancestors }
  })
  on('process.run', ($, e) => {
    touched.push(e.argv.join(' '))
    const [tool, flag, from, path] = e.argv
    expect([tool, flag]).toEqual(['tail', '-c'])
    const bytes = encoder.encode(files[path ?? ''] ?? '')
    return { value: { exitCode: 0, stdout: decoder.decode(bytes.slice(Number(from) - 1)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  // The engine's own band, drawn when the mod passes: no text.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))
  mock.store(on)
  const clock = mock.clock(on)
  const appendTo = (ledger: string, ...records: object[]) => {
    files[ledger] = (files[ledger] ?? '') + records.map(record => `${JSON.stringify(record)}\n`).join('')
  }
  return {
    logs,
    touched,
    clock,
    append: (...records: object[]) => appendTo(LEDGER, ...records),
    appendTo,
  }
}

const start = ($: Engine) => $.session.start({ cwd: `${HOME}/projects/x`, surface: 'terminal', isInteractive: true })
const prompt = ($: Engine, kind: PromptOrigin['kind']) =>
  $.prompt.submit({ text: 'ok', wait: false, origin: { kind } as PromptOrigin })

async function bandText($: Engine): Promise<string[]> {
  const shown: string[] = []
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // The other plugin's row, where a test loads one, then the lamp's.
    const rows = await Promise.all(['prs', 'lamp'].map(key => ui.find({ key })))
    shown.push(rows.map(row => row?.text ?? '').join(''))
    await ui.unmount()
  }
  return shown
}

const status = (task: string, state: string, text: string, key: string | null = null) => ({
  v: 1,
  ts: 1,
  event: 'task.status',
  task,
  state,
  key,
  text,
})

describe('the band', () => {
  test('old history does not flash red; appended lines do, and a captain prompt clears them', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '' }
    const fm = world(on, files)
    fm.append(status('old', 'blocked', ' from yesterday'))
    await start($)
    expect(await bandText($)).toEqual(['', ''])

    fm.append(status('fix-login', 'needs-decision', ' pick A or B'), status('api', 'failed', ' tests red'))
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(Array(2).fill('● api failed: tests red  +1 more'))

    await prompt($, 'task-notification')
    expect((await bandText($))[0]).toContain('api failed')

    await prompt($, 'composer')
    expect(await bandText($)).toEqual(['', ''])

    fm.append({ v: 1, ts: 2, event: 'task.pr_ready', task: 'fix-login', pr: 'https://github.com/acme/web/pull/7' })
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(Array(2).fill('● PR ready https://github.com/acme/web/pull/7  fix-login'))
  })

  test('a keyed red clears itself on its resolved record', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
    const fm = world(on, files)
    await start($)
    fm.append(status('t', 'needs-decision', ' A or B?', 'pick'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● t needs-decision: A or B?')
    fm.append(status('t', 'resolved', ' A', 'pick'))
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(['', ''])
  })

  test('a partial last line waits for the rest', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
    const fm = world(on, files)
    await start($)
    const line = JSON.stringify(status('t', 'blocked', ' stuck'))
    files[LEDGER] += line.slice(0, 20)
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('')
    files[LEDGER] += `${line.slice(20)}\n`
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● t blocked: stuck')
  })

  test('a truncated ledger is read again from the top', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '' }
    const fm = world(on, files)
    fm.append(status('old', 'working', ' a long history line that makes the file big'))
    await start($)
    files[LEDGER] = ''
    fm.append(status('t', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● t blocked: x')
  })

  test('with the ledger off it shows nothing and says once how to turn it on', async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: '' }
    const fm = world(on, files)
    await start($)
    fm.append(status('t', 'blocked', ' x'))
    await fm.clock.advance(6000)
    expect(await bandText($)).toEqual(['', ''])
    expect(fm.logs.filter(text => text.includes(`touch ${FLAG}`))).toHaveLength(1)
  })

  test('a session no one is at follows nothing', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
    const fm = world(on, files)
    await $.session.start({ cwd: `${HOME}/projects/x`, surface: null, isInteractive: false })
    fm.append(status('t', 'blocked', ' x'))
    await fm.clock.advance(120_000)
    expect(fm.touched).toEqual([])
    expect(fm.logs).toEqual([])
  })

  test('only an AGENTS.md headed # Firstmate marks the home, not one that just names it', async ($, on) => {
    const project = `${HOME}/projects/x`
    const files: Record<string, string> = {
      [FLAG]: '',
      [LEDGER]: '',
      [`${project}/config/fleet-ledger`]: '',
      [`${project}/state/fleet-ledger.jsonl`]: '',
    }
    const fm = world(on, files, [...ANCESTORS, { dir: project, name: 'AGENTS.md', content: '# Web app\n\nWorked on by a firstmate fleet.', parts: [] }])
    await start($)
    fm.appendTo(`${project}/state/fleet-ledger.jsonl`, status('wrong', 'failed', ' not the fleet'))
    fm.append(status('t', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● t blocked: x')
  })

  test('the home option overrides the walk', { options: { home: '/elsewhere/fm/' } }, async ($, on) => {
    const files: Record<string, string> = { '/elsewhere/fm/config/fleet-ledger': '', '/elsewhere/fm/state/fleet-ledger.jsonl': '' }
    const fm = world(on, files)
    await start($)
    files['/elsewhere/fm/state/fleet-ledger.jsonl'] += `${JSON.stringify(status('t', 'failed', ' boom'))}\n`
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● t failed: boom')
  })
})

describe('second mate homes', () => {
  // A second mate's decisions reach the captain only once its firstmate records them in the main ledger.
  test("a second mate's ledger never lights the band; the main home's does", async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [MATE_FLAG]: '', [MATE_LEDGER]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    await start($)
    fm.appendTo(
      MATE_LEDGER,
      status('install-date-match-direction', 'needs-decision', ' pick a direction'),
      { v: 1, ts: 2, event: 'task.pr_ready', task: 'ce-po', pr: 'https://github.com/acme/ce/pull/3' },
    )
    await fm.clock.advance(120_000)
    expect(await bandText($)).toEqual(['', ''])

    fm.append(status('constructease', 'needs-decision', ' install-date-match-direction: pick a direction'))
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(Array(2).fill('● constructease needs-decision: install-date-match-direction: pick a direction'))
    expect(fm.touched.filter(path => path === REGISTRY || path.startsWith(`${MATE}/`))).toEqual([])
  })
})

// Another plugin's band row, as pr-weather draws its own: the row, then whatever is beneath.
// Self-contained, as a test's inline plugin must be.
function prsRow(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return h(Box, { flexDirection: 'column' }, h(Box, { key: 'prs' }, h(Text, {}, 'PRs none')), below) as RenderElement
  })
}

describe('beside another band plugin', () => {
  for (const tier of ['prepend', 'append'] as const) {
    test(`the lamp and the other row both show, with the ${tier} tier`, { plugins: [{ name: 'prs', tier, register: prsRow }] }, async ($, on) => {
      const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
      const fm = world(on, files)
      await start($)
      expect(await bandText($)).toEqual(['PRs none', 'PRs none'])

      fm.append(status('lamp-test', 'needs-decision', ' TEST - fleet-lamp check, not a real decision'))
      await fm.clock.advance(2000)
      // The other plugin's row first, the lamp below it, whichever side of the lamp it loads on.
      expect(await bandText($)).toEqual(Array(2).fill('PRs none● lamp-test needs-decision: TEST - fleet-lamp check, not a real decision'))
      expect(fm.logs).toEqual([])
    })
  }

  test('a green lamp keeps the other row too', { plugins: [{ name: 'prs', tier: 'append', register: prsRow }] }, async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
    const fm = world(on, files)
    await start($)
    fm.append({ v: 1, ts: 2, event: 'task.pr_ready', task: 'fix-login', pr: 'https://github.com/acme/web/pull/7' })
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(Array(2).fill('PRs none● PR ready https://github.com/acme/web/pull/7  fix-login'))
  })

  test('the missing-ledger note is a transcript line, once per session, never in the band', async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: '' }
    const fm = world(on, files)
    const missing = `the fleet ledger is off in ${HOME}; turn it on with: touch ${FLAG}`
    await start($)
    fm.append(status('t', 'blocked', ' x'))
    await fm.clock.advance(10_000)
    expect(fm.logs).toEqual([missing])
    expect((await bandText($)).some(text => text.includes('fleet ledger'))).toBe(false)

    // The next session says it again, so a ledger still off is not forgotten.
    await start($)
    expect(fm.logs).toEqual([missing, missing])
  })
})

describe('the line at any width', () => {
  const REASON = " R4 drop the offset-compat path. Criterion cited: repo/global rule 'do not preserve backward compatibility'"
  const narrow = (bodyColumns: number) => ({ ...BAND, props: { ...BAND.props, bodyColumns } })

  for (const bodyColumns of [60, 100, 160]) {
    test(`a red with a long reason stays one spaced line at ${bodyColumns} columns`, async ($, on) => {
      const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '' }
      const fm = world(on, files)
      await start($)
      fm.append(status('ce-ies-file-sync-discovery', 'needs-decision', REASON), status('ce-other', 'blocked', ' x'))
      await fm.clock.advance(2000)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...narrow(bodyColumns), surface })
        const lamp = (await ui.find({ key: 'lamp' }))?.text ?? ''
        await ui.unmount()
        // The terminal keeps its last four cells for the [-] control.
        const room = bodyColumns - (surface === 'terminal' ? 4 : 0)
        expect(lamp.startsWith('● ce-')).toBe(true)
        expect(lamp.endsWith('  +1 more')).toBe(true)
        expect([...lamp].length).toBeLessThanOrEqual(room)
        expect(lamp.includes('\n')).toBe(false)
      }
    })
  }
})
