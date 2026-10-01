// The captain's lamp rules over firstmate's fleet activity ledger (docs/fleet-ledger.md).
// Pure: no `$`, so the tests hold them without a file system.

import type { GreenSignal, Latch, RedSignal } from '../types'

export const EMPTY: Latch = { reds: [], greens: [] }

const RED_STATES = new Set(['needs-decision', 'blocked', 'failed'])
// a held decision re-recorded with the captain's own answer is not a new question
const CAPTAIN_ANSWER = /\bCaptain(?: answer)? \d{4}-\d{2}-\d{2},? verbatim/
const GREEN_PATTERNS = [/PR ready: https:\/\//, /^\s*PR https:\/\//, /child \S+ done: PR https:\/\//]
const LANDED = /\b(landed|merged)\b/
const URL = /https:\/\/\S+/

type LedgerRecord = Readonly<Record<string, unknown>>

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The one-line reason a red shows: the status text, whitespace folded. */
const reasonOf = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Folds one ledger record into the latch; records it does not recognize leave it as it was. */
export function apply(latch: Latch, record: LedgerRecord): Latch {
  const task = text(record.task)
  const ts = typeof record.ts === 'number' ? record.ts : 0

  if (record.event === 'task.pr_ready') {
    return addGreen(latch, { task, pr: text(record.pr) || null, ts })
  }
  if (record.event !== 'task.status') {
    return latch
  }

  const state = text(record.state)
  const key = text(record.key) || null
  const body = text(record.text)

  if (state === 'resolved') {
    return key === null
      ? latch
      : { ...latch, reds: latch.reds.filter(red => !(red.task === task && red.key === key)) }
  }
  if (RED_STATES.has(state) && !body.includes('ask-user findings=') && !CAPTAIN_ANSWER.test(body)) {
    return addRed(latch, { task, key, state, reason: reasonOf(body), ts })
  }
  if (state === 'done' && GREEN_PATTERNS.some(pattern => pattern.test(body)) && !LANDED.test(body)) {
    return addGreen(latch, { task, pr: body.match(URL)?.[0] ?? null, ts })
  }
  return latch
}

/** Parses appended ledger text, complete lines only, and folds each record in order. */
export function applyLines(latch: Latch, lines: string): Latch {
  return lines.split('\n').reduce((next, line) => {
    const record = parse(line)
    return record === null ? next : apply(next, record)
  }, latch)
}

function parse(line: string): LedgerRecord | null {
  if (line.trim() === '') {
    return null
  }
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as LedgerRecord) : null
  } catch {
    return null
  }
}

// The ledger delivers at least once, so a repeated record replaces its twin rather than stacking.
function addRed(latch: Latch, red: RedSignal): Latch {
  const isSame = (other: RedSignal) =>
    other.task === red.task && (red.key === null ? other.key === null && other.reason === red.reason : other.key === red.key)
  return { ...latch, reds: [...latch.reds.filter(other => !isSame(other)), red] }
}

function addGreen(latch: Latch, green: GreenSignal): Latch {
  const isSame = (other: GreenSignal) => (green.pr === null ? other.pr === null && other.task === green.task : other.pr === green.pr)
  return { ...latch, greens: [...latch.greens.filter(other => !isSame(other)), green] }
}

/** What the band shows: the newest open red, else the newest ready PR, else nothing. */
export type Lamp =
  | { color: 'red'; signal: RedSignal; count: number }
  | { color: 'green'; signal: GreenSignal; count: number }
  | null

export function lampOf(latch: Latch): Lamp {
  const red = latch.reds.at(-1)
  if (red) {
    return { color: 'red', signal: red, count: latch.reds.length }
  }
  const green = latch.greens.at(-1)
  return green ? { color: 'green', signal: green, count: latch.greens.length } : null
}
