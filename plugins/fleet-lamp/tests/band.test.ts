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

/** A firstmate home in memory: the files the mod may read, and the calls it made. */
function world(on: On, files: Record<string, string>) {
  const logs: string[] = []
  const exists = (path: string) => path in files || Object.keys(files).some(file => file.startsWith(`${path}/`))
  on('fs.exists', ($, e) => ({ value: exists(e.path) }))
  on('fs.stat', ($, e) => {
    if (!exists(e.path)) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    const isFile = e.path in files
    const size = isFile ? encoder.encode(files[e.path] ?? '').length : 0
    return { value: { kind: isFile ? 'file' : 'dir', size, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (!(e.path in files)) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: files[e.path] ?? '' }
  })
  on('fs.ancestors', () => ({
    value: [
      { dir: '/work', name: 'AGENTS.md', content: '# Some other project', parts: [] },
      { dir: HOME, name: 'AGENTS.md', content: '# Firstmate\n\nThe supervisor contract.', parts: [] },
    ],
  }))
  on('process.run', ($, e) => {
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
    const texts = await ui.findAll({ type: 'Text' })
    shown.push(texts.map(text => text.text).join(''))
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
  test('follows a second mate ledger from its end and names the home a red came from', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [MATE_FLAG]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    fm.appendTo(MATE_LEDGER, status('old', 'blocked', ' from yesterday'))
    await start($)
    expect(await bandText($)).toEqual(['', ''])

    fm.appendTo(MATE_LEDGER, status('ce-po', 'needs-decision', ' pick a vendor'))
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(Array(2).fill('● constructease ce-po needs-decision: pick a vendor'))

    fm.append(status('api', 'failed', ' tests red'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● main api failed: tests red  +1 more')

    await prompt($, 'composer')
    expect(await bandText($)).toEqual(['', ''])

    fm.appendTo(MATE_LEDGER, { v: 1, ts: 2, event: 'task.pr_ready', task: 'ce-po', pr: 'https://github.com/acme/ce/pull/3' })
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● constructease PR ready https://github.com/acme/ce/pull/3  ce-po')
  })

  test('keeps an offset per home, so one ledger truncating rereads only that one', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [MATE_FLAG]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    fm.append(status('old', 'working', ' a long main history line'))
    fm.appendTo(MATE_LEDGER, status('old', 'working', ' a long second mate history line'))
    await start($)
    files[MATE_LEDGER] = ''
    fm.appendTo(MATE_LEDGER, status('ce', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● constructease ce blocked: x')
    fm.append(status('api', 'blocked', ' y'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● main api blocked: y  +1 more')
  })

  test('with only the main home followed, the band names no home', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [REGISTRY]: entry('gone', '/work/gone') }
    const fm = world(on, files)
    await start($)
    fm.append(status('api', 'failed', ' tests red'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● api failed: tests red')
  })

  test('a second mate with its ledger off is noted once and not followed', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [MATE_LEDGER]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    await start($)
    fm.appendTo(MATE_LEDGER, status('ce', 'blocked', ' x'))
    await fm.clock.advance(6000)
    expect(await bandText($)).toEqual(['', ''])
    expect(fm.logs).toEqual([
      `the fleet ledger is off in second mate constructease (${MATE}), so the lamp does not follow it; turn it on with: touch ${MATE_FLAG}`,
    ])
  })

  test('the second mates are followed even while the main ledger is off', async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: '', [MATE_FLAG]: '', [MATE_LEDGER]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    await start($)
    fm.appendTo(MATE_LEDGER, status('ce', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● ce blocked: x')
    expect(fm.logs.filter(text => text.includes(`touch ${FLAG}`))).toHaveLength(1)
  })

  test('a second mate registered mid-session is followed within a minute', async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [MATE_FLAG]: '', [MATE_LEDGER]: '' }
    const fm = world(on, files)
    await start($)
    files[REGISTRY] = entry('constructease', MATE)
    await fm.clock.advance(60_000)
    fm.appendTo(MATE_LEDGER, status('ce', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● constructease ce blocked: x')
  })

  test('includeSecondMates off follows the main home alone', { options: { includeSecondMates: false } }, async ($, on) => {
    const files: Record<string, string> = { [FLAG]: '', [LEDGER]: '', [MATE_FLAG]: '', [MATE_LEDGER]: '', [REGISTRY]: entry('constructease', MATE) }
    const fm = world(on, files)
    await start($)
    fm.appendTo(MATE_LEDGER, status('ce', 'blocked', ' x'))
    await fm.clock.advance(2000)
    expect(await bandText($)).toEqual(['', ''])
    fm.append(status('api', 'failed', ' tests red'))
    await fm.clock.advance(2000)
    expect((await bandText($))[0]).toBe('● api failed: tests red')
  })
})
