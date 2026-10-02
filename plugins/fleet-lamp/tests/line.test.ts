import { describe, expect, test } from 'claude-code/testing'

import { cellWidth, fitLine, MIN_MAIN, MIN_TAIL, truncateCells } from '../hooks/line'
import type { LampLine } from '../hooks/line'

// The captain's red, as seen live in a narrow band.
const RED: LampLine = {
  lead: '● ',
  main: 'ce-ies-file-sync-discovery',
  tail: " needs-decision: R4 drop the offset-compat path. Criterion cited: repo/global rule 'do not preserve backward compatibility'",
  more: '  +1 more',
}
const drawn = (line: LampLine) => line.lead + line.main + line.tail + line.more

describe('cells', () => {
  test('Hangul, CJK and wide emoji take two cells; combining marks none', () => {
    expect(cellWidth('abc')).toBe(3)
    expect(cellWidth('간격이')).toBe(6)
    expect(cellWidth('日本')).toBe(4)
    expect(cellWidth('🚀')).toBe(2)
    expect(cellWidth('é')).toBe(1)
    expect(cellWidth('●·…')).toBe(3)
  })

  test('truncation counts cells, never splits a wide character, and marks the cut', () => {
    expect(truncateCells('abcdef', 6)).toBe('abcdef')
    expect(truncateCells('abcdef', 4)).toBe('abc…')
    expect(truncateCells('간격이없어', 6)).toBe('간격…')
    expect(cellWidth(truncateCells('간격이없어', 5))).toBeLessThanOrEqual(5)
    expect(truncateCells('abc', 0)).toBe('')
  })
})

describe('fitting the lamp line', () => {
  test('a wide band shows it whole', () => {
    expect(fitLine(RED, 200)).toEqual(RED)
  })

  for (const columns of [116, 96, 76, 60, 48, 40]) {
    test(`at ${columns} cells it fits, keeping the dot and count whole`, () => {
      const fitted = fitLine(RED, columns)
      expect(cellWidth(drawn(fitted))).toBeLessThanOrEqual(columns)
      expect(fitted.lead).toBe(RED.lead)
      expect(fitted.more).toBe('  +1 more')
    })
  }

  test('the reason shrinks first, the task untouched', () => {
    const fitted = fitLine(RED, 64)
    expect(fitted.main).toBe(RED.main)
    expect(fitted.tail.startsWith(' needs-decision: R4 drop')).toBe(true)
    expect(fitted.tail.endsWith('…')).toBe(true)
    expect(cellWidth(drawn(fitted))).toBe(64)
  })

  test('the task shrinks only once the reason is down to its minimum', () => {
    const fitted = fitLine(RED, 44)
    expect(cellWidth(fitted.tail)).toBe(MIN_TAIL)
    expect(fitted.main.endsWith('…')).toBe(true)
    expect(cellWidth(fitted.main)).toBeGreaterThanOrEqual(MIN_MAIN)
  })

  test('narrower still, the reason gives way and the task keeps what is left', () => {
    const fitted = fitLine(RED, 20)
    expect(fitted.tail).toBe('')
    expect(cellWidth(drawn(fitted))).toBeLessThanOrEqual(20)
    expect(fitted.main.startsWith('ce-')).toBe(true)
  })

  test('a Korean reason is measured in cells', () => {
    const line = { ...RED, tail: ' needs-decision: 램프랑 글씨랑 붙었어 간격이 없어 그리고 두 줄로 넘어가' }
    const fitted = fitLine(line, 54)
    expect(cellWidth(drawn(fitted))).toBeLessThanOrEqual(54)
    expect(fitted.main).toBe(RED.main)
  })
})
