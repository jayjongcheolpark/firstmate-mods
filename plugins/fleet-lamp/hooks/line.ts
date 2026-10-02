// The lamp's one line, fitted to the band in terminal cells. Pure: the tests hold it without a surface.

// Code points a terminal draws two cells wide: Hangul, CJK, fullwidth forms, wide emoji.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
// Code points that take no cell of their own: combining marks, joiners, variation selectors.
const ZERO = /[\p{Mn}\p{Me}​-‏⁠︀-️]/u

const ELLIPSIS = '…'

function cellsOf(char: string): number {
  if (ZERO.test(char)) return 0
  return WIDE.test(char) ? 2 : 1
}

/** How many terminal cells `text` takes. */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) width += cellsOf(char)
  return width
}

/** `text` cut to at most `max` cells, an ellipsis marking the cut; empty when `max` is below one. */
export function truncateCells(text: string, max: number): string {
  if (cellWidth(text) <= max) return text
  if (max < 1) return ''
  let kept = ''
  let width = 0
  for (const char of text) {
    const cells = cellsOf(char)
    if (width + cells > max - 1) break
    kept += char
    width += cells
  }
  return kept + ELLIPSIS
}

/**
 * The lamp's line in parts, drawn in this order:
 * `lead` (the dot and the home label, kept), `main` (the task or the PR), `tail` (the state and
 * reason, or the task beside a PR), then `more` (the `+N more` count, kept whole).
 */
export type LampLine = { lead: string; main: string; tail: string; more: string }

// The cells the tail keeps before the main part starts to give way.
export const MIN_TAIL = 16
// The cells the main part keeps before the tail gives way entirely.
export const MIN_MAIN = 12
// The fewest cells of tail worth drawing once it has given way.
const MIN_STUB = 4

/**
 * The line fitted to `columns` cells: the tail shrinks first, down to MIN_TAIL; then the main
 * part, down to MIN_MAIN; then the tail to a stub or nothing, then the main part to nothing. The lead
 * and the count are never cut here; a band too narrow even for them is the surface's to cut.
 */
export function fitLine(line: LampLine, columns: number): LampLine {
  const fixed = cellWidth(line.lead) + cellWidth(line.more)
  let room = columns - fixed
  const mainWidth = cellWidth(line.main)
  const tailWidth = cellWidth(line.tail)
  if (mainWidth + tailWidth <= room) return line

  // The tail gives way first, keeping MIN_TAIL cells while the main part fits beside it.
  const tailKept = Math.min(tailWidth, MIN_TAIL)
  if (mainWidth + tailKept <= room) return { ...line, tail: truncateCells(line.tail, room - mainWidth) }

  // Then the main part, keeping MIN_MAIN cells beside the shortened tail.
  const mainKept = Math.min(mainWidth, MIN_MAIN)
  if (mainKept + tailKept <= room) {
    return { ...line, main: truncateCells(line.main, room - tailKept), tail: truncateCells(line.tail, tailKept) }
  }

  // Then the tail goes, but for a stub of it where a few cells are left, and the main part takes the rest.
  room = Math.max(0, room)
  const main = truncateCells(line.main, room)
  const left = room - cellWidth(main)
  return { ...line, main, tail: left >= MIN_STUB ? truncateCells(line.tail, left) : '' }
}
