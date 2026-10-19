// The pure half of pr-weather: classifying gh's answers, folding the fleet
// ledger, and laying the band out. register.tsx does the I/O around these.
import type { Ci, Pr } from '../types'

export type Glyph = { mark: string; color: string }

export const GLYPHS = {
  held: { mark: '↯', color: 'magenta' },
  failed: { mark: '☂', color: 'red' },
  conflicting: { mark: '⚔', color: 'red' },
  running: { mark: '☁', color: 'yellow' },
  draft: { mark: '✎', color: 'gray' },
  passed: { mark: '☀', color: 'green' },
  none: { mark: '-', color: 'gray' },
} as const satisfies Record<string, Glyph>

// Held for approval > failed > conflicting > running > draft > passed (or no checks).
export function glyph(pr: Pr): Glyph {
  if (pr.isHeld) return GLYPHS.held
  if (pr.ci === 'failed') return GLYPHS.failed
  if (pr.isConflicting) return GLYPHS.conflicting
  if (pr.ci === 'running') return GLYPHS.running
  if (pr.isDraft) return GLYPHS.draft
  return pr.ci === 'passed' ? GLYPHS.passed : GLYPHS.none
}

// One statusCheckRollup entry, as `gh pr view --json statusCheckRollup` prints it.
// A CheckRun carries name, workflowName, status and conclusion. A StatusContext
// carries context and state. startedAt and completedAt place the run in time.
export type RollupItem = {
  __typename?: string
  name?: string | null
  workflowName?: string | null
  context?: string | null
  status?: string | null
  conclusion?: string | null
  state?: string | null
  startedAt?: string | null
  completedAt?: string | null
}

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'])
const RUNNING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

function isStatusContext(item: RollupItem): boolean {
  return item.__typename === 'StatusContext' || (item.status == null && item.state != null)
}

function outcome(item: RollupItem): 'failed' | 'running' | 'passed' {
  if (isStatusContext(item)) {
    const state = (item.state ?? '').toUpperCase()
    if (FAILED.has(state)) return 'failed'
    return RUNNING.has(state) ? 'running' : 'passed'
  }
  const status = (item.status ?? '').toUpperCase()
  if (status !== 'COMPLETED') return 'running'
  return FAILED.has((item.conclusion ?? '').toUpperCase()) ? 'failed' : 'passed'
}

// GitHub keeps a superseded run in the rollup. The same check is name plus
// workflow for a CheckRun, and context for a StatusContext.
function checkKey(item: RollupItem): string {
  if (isStatusContext(item)) return `context\0${item.context ?? ''}`
  return `run\0${item.name ?? ''}\0${item.workflowName ?? ''}`
}

function stamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

// The later of the two times gh records. A run still going has only startedAt.
function when(item: RollupItem): number | null {
  const times = [stamp(item.startedAt), stamp(item.completedAt)].filter((ms): ms is number => ms != null)
  return times.length === 0 ? null : Math.max(...times)
}

// A candidate replaces the kept run when its time is later or equal. With no
// time on either side, the later entry in the rollup wins.
function replaces(kept: RollupItem, candidate: RollupItem): boolean {
  const keptAt = when(kept)
  const candidateAt = when(candidate)
  if (keptAt != null && candidateAt != null) return candidateAt >= keptAt
  return true
}

function latestRuns(items: readonly RollupItem[]): RollupItem[] {
  const indexByKey = new Map<string, number>()
  const latest: RollupItem[] = []
  for (const item of items) {
    const key = checkKey(item)
    const index = indexByKey.get(key)
    if (index === undefined) {
      indexByKey.set(key, latest.length)
      latest.push(item)
      continue
    }
    const kept = latest[index]
    if (kept && replaces(kept, item)) latest[index] = item
  }
  return latest
}

export function classifyRollup(items: readonly RollupItem[] | null | undefined): Ci {
  if (!items || items.length === 0) return 'none'
  const outcomes = latestRuns(items).map(outcome)
  if (outcomes.includes('failed')) return 'failed'
  if (outcomes.includes('running')) return 'running'
  return 'passed'
}

// A done status that reports a ready PR, and one that reports it landed: fleet-lamp's green rule.
const READY_PATTERNS = [/PR ready: https:\/\//, /^\s*PR https:\/\//, /child \S+ done: PR https:\/\//]
const LANDED = /\b(landed|merged)\b/

// Drop "not merged", "not yet merged", "never merged", and "not merged or landed"
// before the landed test. "unmerged" never matches LANDED: there is no word
// boundary before "merged".
function withoutNegatedLanded(body: string): string {
  return body.replace(/\b(?:not|never)\b(?:\s+\w+){0,2}\s+(?:landed|merged)\b(?:\s+or\s+(?:landed|merged)\b)?/gi, ' ')
}
const PR_URL = /https:\/\/[^\s"]+\/pull\/\d+/

// The fleet's PR URLs from fleet-ledger.jsonl text (docs/fleet-ledger.md in
// firstmate): task.pr_ready, or a done task.status that reports a ready PR,
// sets the task's PR (a later one replaces it); task.merged, task.cleaned_up,
// or a done status that reports the PR landed or merged drops it. A negated
// report ("not merged", "never landed") keeps it. Torn or foreign lines are skipped.
export function prsFromLedger(text: string): string[] {
  const byTask = new Map<string, string>()
  for (const line of text.split('\n')) {
    let record: { event?: unknown; task?: unknown; pr?: unknown; state?: unknown; text?: unknown }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record?.task !== 'string') continue
    if (record.event === 'task.pr_ready' && typeof record.pr === 'string') {
      byTask.set(record.task, record.pr)
    } else if (record.event === 'task.merged' || record.event === 'task.cleaned_up') {
      byTask.delete(record.task)
    } else if (record.event === 'task.status' && record.state === 'done' && typeof record.text === 'string') {
      const body = record.text
      const url = PR_URL.exec(body)?.[0]
      if (!url || !READY_PATTERNS.some(pattern => pattern.test(body))) continue
      if (LANDED.test(withoutNegatedLanded(body))) byTask.delete(record.task)
      else byTask.set(record.task, url)
    }
  }
  return [...new Set(byTask.values())]
}

// Where a PR URL lives, for the gh api calls about it.
export function repoOf(url: string): { host: string; repo: string } | null {
  const match = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)
  return match?.[1] && match[2] ? { host: match[1], repo: match[2] } : null
}

export const MINUTE = 60_000
export const MAX_BACKOFF_MS = 30 * MINUTE

// How long ago, as the band says it: "just now", "4m ago", "2h ago".
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

// Minutes as the band says them: "12m", "1h", "1h30m".
export function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return `${Math.floor(minutes / 60)}h${rest ? `${rest}m` : ''}`
}

// What is left of the GitHub quota, from `gh api rate_limit`: the lowest of the
// REST (core) and GraphQL buckets gh spends, with that bucket's reset time.
export type Quota = { ratio: number; remaining: number; resetAt: number }

export function quotaOf(body: unknown): Quota | null {
  const resources = (body as { resources?: Record<string, unknown> } | null)?.resources
  let low: Quota | null = null
  for (const name of ['core', 'graphql']) {
    const bucket = resources?.[name] as { limit?: unknown; remaining?: unknown; reset?: unknown } | undefined
    if (typeof bucket?.limit !== 'number' || typeof bucket.remaining !== 'number' || typeof bucket.reset !== 'number') continue
    if (bucket.limit <= 0) continue
    const quota = { ratio: bucket.remaining / bucket.limit, remaining: bucket.remaining, resetAt: bucket.reset * 1000 }
    if (!low || quota.ratio < low.ratio) low = quota
  }
  return low
}

// Below a tenth of the quota, auto mode doubles its wait each round, up to 30
// minutes (or the configured interval, when that is longer); above it, null.
export function nextBackoff(quota: Quota | null, baseMs: number, backoffMs: number | null): number | null {
  if (!quota || quota.ratio >= 0.1) return null
  return Math.min(Math.max(MAX_BACKOFF_MS, baseMs), (backoffMs ?? baseMs) * 2)
}

// gh's words for a primary or secondary rate limit.
export function isRateLimited(stderr: string): boolean {
  return /rate limit|HTTP 429|abuse detection|submitted too quickly/i.test(stderr)
}

// Terminals Claude Code draws a Link in as a real hyperlink (OSC 8). Elsewhere
// it prints the URL after the text, which no one-line band has room for, so
// the band draws a plain #N there. FORCE_HYPERLINK overrides, as it does for Claude Code.
const LINKING_TERMINALS = new Set(['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2', 'WarpTerminal', 'WezTerm', 'vscode'])

export function terminalDrawsLinks(forceHyperlink: string | undefined, termProgram: string | undefined): boolean {
  if (forceHyperlink !== undefined) return !(forceHyperlink.length > 0 && Number.parseInt(forceHyperlink, 10) === 0)
  return termProgram !== undefined && LINKING_TERMINALS.has(termProgram)
}

const LABEL = 'PRs'

const itemWidth = (pr: Pr) => ` ${glyph(pr).mark} #${pr.number}`.length
const moreWidth = (hidden: number) => (hidden > 0 ? ` +${hidden} more`.length : 0)

// As many PRs as fit one line of `columns` cells beside a tail of `tail`
// cells (the time, notes and buttons), the rest counted as +N more.
export function layoutBand(prs: readonly Pr[], columns: number, tail: number): { shown: Pr[]; hidden: number } {
  const fixed = LABEL.length + tail
  const ends = [fixed]
  for (const pr of prs) ends.push((ends.at(-1) ?? fixed) + itemWidth(pr))
  let count = prs.length
  while (count > 0 && (ends[count] ?? 0) + moreWidth(prs.length - count) > columns) count -= 1
  return { shown: prs.slice(0, count), hidden: prs.length - count }
}
